// Package library serves the desktop app and its per-user reference library.
package library

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
)

const (
	stateLimit        = 10 * 1024 * 1024
	imageLimit        = 20 * 1024 * 1024
	imageReleaseLimit = 64 * 1024
	importLimit       = 8192
	privateCache      = "private, no-store"
)

// ImportedVideo is the metadata and raster thumbnail retrieved by an importer.
type ImportedVideo struct {
	Name, Publisher, URL, MIME string
	Data                       []byte
}

// APIError carries a localized error key and HTTP status.
type APIError struct {
	Key    string
	Status int
}

func (e *APIError) Error() string { return e.Key }

// UpdateEndpoint provides the bundled version and the desktop updater.
type UpdateEndpoint struct {
	Version string
	Check   func(context.Context) (any, error)
	Install func(context.Context, string) error
}

type library struct {
	dataDir          string
	web              fs.FS
	importer         func(context.Context, string) (ImportedVideo, error)
	update           UpdateEndpoint
	installingUpdate atomic.Bool

	stateMu   sync.RWMutex
	revision  int64
	trash     []any
	snapshot  []byte
	imageRefs map[imageReference]struct{}

	imageMu        sync.RWMutex
	pendingUploads map[string]int
}

// New opens the private data directory and creates a handler for MyGo's app protocol.
func New(dataDir string, web fs.FS, importer func(context.Context, string) (ImportedVideo, error), updates ...UpdateEndpoint) (http.Handler, error) {
	root, err := prepareDataDir(dataDir)
	if err != nil {
		return nil, errors.New("could not open the library data directory")
	}
	defer root.Close()

	saved, err := readPrivateFile(root, "state.json", stateLimit)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return nil, errors.New("could not read the library state")
	}
	hasSavedState := err == nil
	if !hasSavedState {
		saved = []byte(defaultState)
	}
	state, ok := decodeObject(saved)
	if !ok {
		return nil, errors.New("the library state is invalid")
	}
	if _, ok := state["trash"]; !ok {
		state["trash"] = []any{}
	}
	revision, ok := validState(state)
	if !ok {
		return nil, errors.New("the library state is invalid")
	}
	snapshot, err := encodeState(state)
	if err != nil {
		return nil, errors.New("could not encode the library state")
	}
	refs := referencedImages(state)
	if hasSavedState {
		reclaimOrphanedRasters(root, liveImagePaths(refs))
	}
	s := &library{
		dataDir: dataDir, web: web, importer: importer,
		revision: revision, trash: state["trash"].([]any), snapshot: snapshot, imageRefs: refs,
		pendingUploads: make(map[string]int),
	}
	if len(updates) > 0 {
		s.update = updates[0]
	}
	return s, nil
}

var assetTypes = map[string]string{
	"index.html": "text/html; charset=utf-8",
	"app.js":     "text/javascript; charset=utf-8",
	"locale.js":  "text/javascript; charset=utf-8",
	"library.js": "text/javascript; charset=utf-8",
	"board.js":   "text/javascript; charset=utf-8",
	"style.css":  "text/css; charset=utf-8",
	"board.css":  "text/css; charset=utf-8",
}

func (s *library) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	header := w.Header()
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Cross-Origin-Resource-Policy", "same-origin")
	header.Set("Referrer-Policy", "no-referrer")
	header.Set("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
	err := s.serve(w, r)
	if err == nil {
		return
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr == nil || apiErr.Key == "" || apiErr.Status < 400 || apiErr.Status > 599 {
		apiErr = &APIError{"serverError", http.StatusInternalServerError}
	}
	payload, _ := json.Marshal(map[string]string{"error": apiErr.Key})
	writeJSON(w, r, apiErr.Status, payload)
}

func nativeRequest(r *http.Request) bool {
	// MyGo uses the canonical scheme URL even on Windows and marks the
	// request with the originating native window. Its handler has no listener.
	if !strings.HasPrefix(r.RemoteAddr, "mygo:") || r.Host != "localhost" ||
		r.URL.Scheme != "mygo" || r.URL.Host != "localhost" || r.URL.User != nil ||
		!strings.HasPrefix(r.URL.Path, "/") || strings.HasPrefix(r.URL.Path, "//") {
		return false
	}
	switch r.Header.Get("Sec-Fetch-Site") {
	case "", "none", "same-origin":
	default:
		return false
	}
	origins := r.Header.Values("Origin")
	if len(origins) == 0 {
		return true
	}
	if len(origins) != 1 {
		return false
	}
	origin := origins[0]
	return origin == "" || origin == "mygo://localhost" ||
		(runtime.GOOS == "windows" && origin == "http://mygo.localhost")
}

func (s *library) serve(w http.ResponseWriter, r *http.Request) error {
	if !nativeRequest(r) {
		return &APIError{"invalidRequest", http.StatusBadRequest}
	}
	if r.URL.EscapedPath() != r.URL.Path {
		return &APIError{"notFound", http.StatusNotFound}
	}
	switch r.URL.Path {
	case "/api/version":
		if r.Method != http.MethodGet {
			return methodError(w, "GET")
		}
		payload, _ := json.Marshal(map[string]string{"version": s.update.Version})
		writeJSON(w, r, http.StatusOK, payload)
		return nil
	case "/api/update":
		if r.Method != http.MethodPost {
			return methodError(w, "POST")
		}
		if err := requireWriteMarker(r); err != nil {
			return err
		}
		return s.checkUpdate(w, r)
	case "/api/update/install":
		return s.installUpdate(w, r)
	case "/api/state":
		switch r.Method {
		case http.MethodGet:
			s.stateMu.RLock()
			snapshot := s.snapshot
			s.stateMu.RUnlock()
			writeJSON(w, r, http.StatusOK, snapshot)
			return nil
		case http.MethodPut:
			if err := requireWriteMarker(r); err != nil {
				return err
			}
			draft, err := requestObject(w, r, stateLimit, "invalidState")
			if err != nil {
				return err
			}
			saved, err := s.saveState(draft)
			if err != nil {
				return err
			}
			writeJSON(w, r, http.StatusOK, saved)
			return nil
		default:
			return methodError(w, "GET, PUT")
		}
	case "/api/image":
		if r.Method != http.MethodPost {
			return methodError(w, "POST")
		}
		if err := requireWriteMarker(r); err != nil {
			return err
		}
		body, err := requestBody(w, r, imageLimit, "imageTooLarge")
		if err != nil {
			return err
		}
		image, err := s.saveRaster(body, r.Header.Get("Content-Type"))
		if err != nil {
			return err
		}
		payload, _ := json.Marshal(map[string]string{"image": image})
		writeJSON(w, r, http.StatusOK, payload)
		return nil
	case "/api/image/release":
		if r.Method != http.MethodPost {
			return methodError(w, "POST")
		}
		if err := requireWriteMarker(r); err != nil {
			return err
		}
		return s.releaseImages(w, r)
	case "/api/import":
		if r.Method != http.MethodPost {
			return methodError(w, "POST")
		}
		if err := requireWriteMarker(r); err != nil {
			return err
		}
		return s.importVideo(w, r)
	default:
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			return methodError(w, "GET, HEAD")
		}
		return s.serveAsset(w, r)
	}
}

func (s *library) checkUpdate(w http.ResponseWriter, r *http.Request) error {
	failed := &APIError{"updateCheckFailed", http.StatusBadGateway}
	if s.update.Check == nil {
		return failed
	}
	result, err := s.update.Check(r.Context())
	if err != nil {
		return failed
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return failed
	}
	writeJSON(w, r, http.StatusOK, payload)
	return nil
}

func (s *library) installUpdate(w http.ResponseWriter, r *http.Request) error {
	if r.Method != http.MethodPost {
		return methodError(w, "POST")
	}
	if err := requireWriteMarker(r); err != nil {
		return err
	}
	body, err := requestObject(w, r, 256, "invalidRequest")
	if err != nil {
		return err
	}
	version, _ := body["version"].(string)
	if version == "" || len(version) > 64 || len(body) != 1 {
		return &APIError{"invalidRequest", http.StatusBadRequest}
	}
	if s.update.Install == nil {
		return &APIError{"updateInstallUnavailable", http.StatusConflict}
	}
	if !s.installingUpdate.CompareAndSwap(false, true) {
		return &APIError{"updateInstallBusy", http.StatusConflict}
	}
	if err := s.update.Install(r.Context(), version); err != nil {
		s.installingUpdate.Store(false)
		var localized *APIError
		if errors.As(err, &localized) {
			return localized
		}
		return &APIError{"updateInstallFailed", http.StatusBadGateway}
	}
	writeJSON(w, r, http.StatusOK, []byte(`{"installed":true}`))
	return nil
}

func requireWriteMarker(r *http.Request) error {
	// A page on another origin cannot add this non-safelisted header without preflight.
	if values := r.Header.Values("X-Inspiration-Request"); len(values) != 1 || values[0] != "1" {
		return &APIError{"invalidRequest", http.StatusBadRequest}
	}
	return nil
}

func methodError(w http.ResponseWriter, allow string) error {
	w.Header().Set("Allow", allow)
	return &APIError{"methodNotAllowed", http.StatusMethodNotAllowed}
}

func (s *library) serveAsset(w http.ResponseWriter, r *http.Request) error {
	name := strings.TrimPrefix(r.URL.Path, "/")
	if name == "" {
		name = "index.html"
	}
	if mediaType, ok := assetTypes[name]; ok && s.web != nil {
		data, err := fs.ReadFile(s.web, name)
		if err != nil {
			return assetError(err)
		}
		writeBytes(w, r, http.StatusOK, data, mediaType, "no-cache")
		return nil
	}
	if !imagePath.MatchString(r.URL.Path) {
		return &APIError{"notFound", http.StatusNotFound}
	}
	data, err := s.readRaster(path.Base(name))
	if err != nil {
		return assetError(err)
	}
	mediaType := rasterMIME[strings.TrimPrefix(path.Ext(name), ".")]
	writeBytes(w, r, http.StatusOK, data, mediaType, privateCache)
	return nil
}

func assetError(err error) error {
	if errors.Is(err, fs.ErrNotExist) {
		return &APIError{"notFound", http.StatusNotFound}
	}
	return err
}

func (s *library) importVideo(w http.ResponseWriter, r *http.Request) error {
	body, err := requestObject(w, r, importLimit, "invalidRequest")
	if err != nil {
		return err
	}
	input, _ := body["url"].(string)
	input = strings.TrimSpace(input)
	if input == "" || len(input) > 2048 || !validVideoInput(input) {
		return &APIError{"unsupportedVideoUrl", http.StatusBadRequest}
	}
	if s.importer == nil {
		return &APIError{"videoUnavailable", http.StatusBadGateway}
	}
	video, err := s.importer(r.Context(), input)
	if err != nil {
		return err
	}
	if strings.TrimSpace(video.Name) == "" || video.URL == "" || !originalURL(video.URL) {
		return &APIError{"videoUnavailable", http.StatusBadGateway}
	}
	image, err := s.saveRaster(video.Data, video.MIME)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]string{
		"name": video.Name, "publisher": video.Publisher, "url": video.URL, "image": image,
	})
	writeJSON(w, r, http.StatusOK, payload)
	return nil
}

func requestBody(w http.ResponseWriter, r *http.Request, limit int64, key string) ([]byte, error) {
	if r.ContentLength > limit {
		return nil, &APIError{key, http.StatusRequestEntityTooLarge}
	}
	if r.Body == nil {
		return nil, nil
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, limit))
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		return nil, &APIError{key, http.StatusRequestEntityTooLarge}
	}
	if err != nil {
		return nil, &APIError{"invalidRequest", http.StatusBadRequest}
	}
	return body, nil
}

func requestObject(w http.ResponseWriter, r *http.Request, limit int64, shapeError string) (map[string]any, error) {
	if bareMIME(r.Header.Get("Content-Type")) != "application/json" {
		return nil, &APIError{"invalidRequest", http.StatusUnsupportedMediaType}
	}
	body, err := requestBody(w, r, limit, "invalidRequest")
	if err != nil {
		return nil, err
	}
	value, err := decodeValue(body)
	if err != nil {
		return nil, &APIError{"invalidRequest", http.StatusBadRequest}
	}
	record, ok := value.(map[string]any)
	if !ok {
		return nil, &APIError{shapeError, http.StatusBadRequest}
	}
	return record, nil
}

func decodeValue(data []byte) (any, error) {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil {
		return nil, err
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, errors.New("unexpected data after JSON value")
	}
	return value, nil
}

func decodeObject(data []byte) (map[string]any, bool) {
	value, err := decodeValue(data)
	record, ok := value.(map[string]any)
	return record, err == nil && ok
}

func bareMIME(contentType string) string {
	mediaType, _, _ := strings.Cut(contentType, ";")
	return strings.ToLower(strings.TrimSpace(mediaType))
}

func writeJSON(w http.ResponseWriter, r *http.Request, status int, payload []byte) {
	writeBytes(w, r, status, payload, "application/json; charset=utf-8", privateCache)
}

func writeBytes(w http.ResponseWriter, r *http.Request, status int, data []byte, mediaType, cache string) {
	w.Header().Set("Content-Type", mediaType)
	w.Header().Set("Content-Length", strconv.Itoa(len(data)))
	w.Header().Set("Cache-Control", cache)
	w.WriteHeader(status)
	if r.Method != http.MethodHead {
		_, _ = w.Write(data)
	}
}
