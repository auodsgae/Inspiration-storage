package library

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"testing/fstest"
)

var testAssets = fstest.MapFS{
	"index.html": &fstest.MapFile{Data: []byte("<!doctype html>")},
	"app.js":     &fstest.MapFile{Data: []byte("export {}")},
	".env":       &fstest.MapFile{Data: []byte("private")},
}

func openLibrary(t *testing.T, dir string, importer func(context.Context, string) (ImportedVideo, error)) http.Handler {
	t.Helper()
	h, err := New(dir, testAssets, importer)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

func request(method, path string, body io.Reader, contentType string) *http.Request {
	req := httptest.NewRequest(method, "mygo://localhost"+path, body)
	req.RemoteAddr = "mygo:1"
	if method == http.MethodPut || method == http.MethodPost {
		req.Header.Set("X-Inspiration-Request", "1")
		req.Header.Set("Origin", "mygo://localhost")
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	return req
}

func send(h http.Handler, req *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	return w
}

func requireError(t *testing.T, got *httptest.ResponseRecorder, status int, key string) {
	t.Helper()
	var body struct{ Error string }
	if got.Code != status || json.Unmarshal(got.Body.Bytes(), &body) != nil || body.Error != key {
		t.Fatalf("got %d %s, want %d %s", got.Code, got.Body.String(), status, key)
	}
}

func stateResponse(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	if response.Code != http.StatusOK {
		t.Fatalf("state returned %d %s", response.Code, response.Body.String())
	}
	var data map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	return data
}

func saveState(t *testing.T, h http.Handler, value map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return send(h, request(http.MethodPut, "/api/state", bytes.NewReader(body), "application/json"))
}

func fixtureImage(t *testing.T) []byte {
	t.Helper()
	return fixturePNG(t, 1)
}

func TestFreshLibraryUsesEmptyListsAndDefaultLabels(t *testing.T) {
	h := openLibrary(t, t.TempDir(), nil)
	result := send(h, request(http.MethodGet, "/api/state", nil, ""))
	got := stateResponse(t, result)
	for _, key := range []string{"layouts", "trash", "boards"} {
		if !reflect.DeepEqual(got[key], []any{}) {
			t.Errorf("%s = %#v, want empty array", key, got[key])
		}
	}
	if !reflect.DeepEqual(got["settings"], map[string]any{"theme": "light", "language": nil}) {
		t.Errorf("settings = %#v", got["settings"])
	}
	wantLabels := []string{"favorite", "gaming", "podcast", "web", "essay", "tutorial"}
	var labels []string
	for _, label := range got["labels"].([]any) {
		labels = append(labels, label.(map[string]any)["id"].(string))
	}
	if !reflect.DeepEqual(labels, wantLabels) || got["revision"] != float64(0) {
		t.Errorf("labels %v, revision %v", labels, got["revision"])
	}
	if result.Header().Get("Cache-Control") != "private, no-store" {
		t.Error("state response must not be cached")
	}
}

func TestConcurrentRevisionsAndOptionalFieldsSurviveRestart(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	original := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	revision := make(chan *httptest.ResponseRecorder, 2)
	for _, theme := range []string{"light", "dark"} {
		draft := map[string]any{
			"revision": original["revision"],
			"labels":   []any{map[string]any{"id": "favorite", "name": "Favorite", "pinned": true}},
			"layouts":  []any{},
			"boards":   []any{map[string]any{"id": "b", "name": "Board", "items": []any{}, "custom": true}},
			"settings": map[string]any{"theme": theme, "language": "zh-Hant", "collections": []any{
				map[string]any{"id": "c", "name": "Collection", "labelIds": []any{"favorite"}, "query": "match", "ratio": "16:9"},
			}},
		}
		body, err := json.Marshal(draft)
		if err != nil {
			t.Fatal(err)
		}
		go func() {
			revision <- send(h, request(http.MethodPut, "/api/state", bytes.NewReader(body), "application/json"))
		}()
	}
	first, second := <-revision, <-revision
	if first.Code != http.StatusOK {
		first, second = second, first
	}
	winner := stateResponse(t, first)
	requireError(t, second, http.StatusConflict, "revisionConflict")
	if winner["revision"] != float64(1) || !reflect.DeepEqual(winner["trash"], []any{}) {
		t.Errorf("revision or legacy trash fallback missing: %#v", winner)
	}
	b := winner["boards"].([]any)[0].(map[string]any)
	l := winner["labels"].([]any)[0].(map[string]any)
	if b["custom"] != true || l["pinned"] != true || len(winner["settings"].(map[string]any)["collections"].([]any)) != 1 {
		t.Errorf("optional fields were lost: %#v", winner)
	}
	reopened := openLibrary(t, dir, nil)
	got := stateResponse(t, send(reopened, request(http.MethodGet, "/api/state", nil, "")))
	if !reflect.DeepEqual(got, winner) {
		t.Fatalf("reopened state differs from winner")
	}
	if saved := stateResponse(t, saveState(t, reopened, got)); saved["revision"] != float64(2) {
		t.Errorf("second replacement yielded revision %v", saved["revision"])
	}
	if runtime.GOOS != "windows" {
		for name, limit := range map[string]os.FileMode{".": 0700, "images": 0700, "state.json": 0600} {
			info, err := os.Stat(filepath.Join(dir, name))
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != limit {
				t.Errorf("%s permissions %o, want %o", name, info.Mode().Perm(), limit)
			}
		}
	}
}

func TestWhiteboardViewIsOptionalAndSurvivesReopening(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	draft := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	board := map[string]any{"id": "b", "name": "Board", "items": []any{}}
	draft["boards"] = []any{board}
	view := map[string]any{"x": -318.5, "y": 95.25, "scale": 1.75}
	for _, invalid := range []any{nil, map[string]any{"x": 0, "y": 0, "scale": 0}, map[string]any{"x": "0", "y": 0, "scale": 1}} {
		board["view"] = invalid
		requireError(t, saveState(t, h, draft), http.StatusBadRequest, "invalidState")
	}
	board["view"] = view
	stateResponse(t, saveState(t, h, draft))
	h = openLibrary(t, dir, nil)
	reopened := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	savedView := reopened["boards"].([]any)[0].(map[string]any)["view"]
	if !reflect.DeepEqual(savedView, view) {
		t.Fatalf("reopened view was %#v, want %#v", savedView, view)
	}
}

func TestUploadsUsePrivateContentAddressedImages(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	png := fixtureImage(t)
	result := send(h, request(http.MethodPost, "/api/image", bytes.NewReader(png), "image/x-png; charset=us-ascii"))
	if result.Code != http.StatusOK {
		t.Fatalf("upload returned %d %s", result.Code, result.Body.String())
	}
	var data struct{ Image string }
	if err := json.Unmarshal(result.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	expected := fmt.Sprintf("/images/%x.png", sha256.Sum256(png))
	if data.Image != expected {
		t.Errorf("image path = %s, want %s", data.Image, expected)
	}
	reopened := openLibrary(t, dir, nil)
	get := send(reopened, request(http.MethodGet, data.Image, nil, ""))
	if get.Code != http.StatusOK || !bytes.Equal(get.Body.Bytes(), png) ||
		get.Header().Get("Content-Type") != "image/png" || get.Header().Get("Cache-Control") != "private, no-store" {
		t.Errorf("image returned %d with headers %v", get.Code, get.Header())
	}
	head := send(reopened, request(http.MethodHead, data.Image, nil, ""))
	if head.Code != http.StatusOK || head.Body.Len() != 0 || head.Header().Get("Content-Length") != strconv.Itoa(len(png)) {
		t.Errorf("HEAD returned %d with %d bytes and headers %v", head.Code, head.Body.Len(), head.Header())
	}
	if info, err := os.Stat(filepath.Join(dir, strings.TrimPrefix(data.Image, "/"))); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Errorf("image permissions %o, want 0600", info.Mode().Perm())
	}
	bad := send(h, request(http.MethodPost, "/api/image", bytes.NewReader(png), "image/gif"))
	requireError(t, bad, http.StatusUnsupportedMediaType, "unsupportedImage")
}

func TestOnlyPackagedRoutesAndNativeRequestsAreServed(t *testing.T) {
	h := openLibrary(t, t.TempDir(), nil)
	page := send(h, request(http.MethodGet, "/", nil, ""))
	csp := page.Header().Get("Content-Security-Policy")
	if page.Code != http.StatusOK || page.Header().Get("Referrer-Policy") != "no-referrer" ||
		!strings.Contains(csp, "default-src 'none'") || !strings.Contains(csp, "script-src 'self'") ||
		strings.Contains(csp, "https:") {
		t.Errorf("entry returned %d with headers %v", page.Code, page.Header())
	}
	for _, path := range []string{"/state.json", "/seed.json", "/examples/demo.jpg", "/.env", "/images/../state.json", "/images/%2e%2e/state.json"} {
		t.Run(path, func(t *testing.T) {
			requireError(t, send(h, request(http.MethodGet, path, nil, "")), http.StatusNotFound, "notFound")
		})
	}
	ordinaryHTTP := httptest.NewRequest(http.MethodGet, "http://mygo.localhost/api/state", nil)
	requireError(t, send(h, ordinaryHTTP), http.StatusBadRequest, "invalidRequest")

	crossOrigin := request(http.MethodPost, "/api/image", bytes.NewReader(fixtureImage(t)), "image/png")
	crossOrigin.Header.Set("Origin", "https://example.com")
	requireError(t, send(h, crossOrigin), http.StatusBadRequest, "invalidRequest")

	crossSite := request(http.MethodGet, "/api/state", nil, "")
	crossSite.Header.Set("Sec-Fetch-Site", "cross-site")
	requireError(t, send(h, crossSite), http.StatusBadRequest, "invalidRequest")

	simplePost := request(http.MethodPost, "/api/image", bytes.NewReader(fixtureImage(t)), "image/png")
	simplePost.Header.Del("X-Inspiration-Request")
	requireError(t, send(h, simplePost), http.StatusBadRequest, "invalidRequest")
	requireError(t, send(h, request(http.MethodOptions, "/api/image", nil, "")), http.StatusMethodNotAllowed, "methodNotAllowed")
}

func TestStateAndImageRejectMalformedInput(t *testing.T) {
	h := openLibrary(t, t.TempDir(), nil)
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	for _, invalid := range []struct {
		image string
		url   string
	}{
		{"/examples/demo.jpg", ""},
		{"/images/../state.json", ""},
		{"/images/" + strings.Repeat("a", 64) + ".png", "javascript:alert(1)"},
		{"/images/" + strings.Repeat("a", 64) + ".png", "https://user:pass@example.com/"},
	} {
		state["layouts"] = []any{map[string]any{
			"id": "a", "name": "Layout", "publisher": "", "url": invalid.url, "image": invalid.image, "labels": []any{},
		}}
		requireError(t, saveState(t, h, state), http.StatusBadRequest, "invalidState")
	}
	body := request(http.MethodPost, "/api/image", bytes.NewReader(fixtureImage(t)), "image/png")
	body.ContentLength = 20*1024*1024 + 1
	requireError(t, send(h, body), http.StatusRequestEntityTooLarge, "imageTooLarge")
	requireError(t, send(h, request(http.MethodPut, "/api/state", strings.NewReader("{}{}"), "application/json")), http.StatusBadRequest, "invalidRequest")
}

func TestVideoImportStoresRasterAndReturnsProviderError(t *testing.T) {
	png := fixtureImage(t)
	h := openLibrary(t, t.TempDir(), func(_ context.Context, input string) (ImportedVideo, error) {
		if input == "https://youtu.be/abcdefghi01" {
			return ImportedVideo{Name: "Video", Publisher: "Creator", URL: "https://www.youtube.com/watch?v=abcdefghi01", MIME: "image/png", Data: png}, nil
		}
		return ImportedVideo{}, &APIError{Key: "videoUnavailable", Status: http.StatusBadGateway}
	})
	w := send(h, request(http.MethodPost, "/api/import", strings.NewReader(`{"url":"https://youtu.be/abcdefghi01"}`), "application/json"))
	if w.Code != http.StatusOK {
		t.Fatalf("import returned %d %s", w.Code, w.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got["name"] != "Video" || got["publisher"] != "Creator" || got["url"] != "https://www.youtube.com/watch?v=abcdefghi01" {
		t.Errorf("wrong import metadata: %v", got)
	}
	if raster := send(h, request(http.MethodGet, got["image"], nil, "")); !bytes.Equal(raster.Body.Bytes(), png) {
		t.Errorf("wrong imported raster: %d", raster.Code)
	}
	requireError(t, send(h, request(http.MethodPost, "/api/import", strings.NewReader(`{"url":"https://youtu.be/abcdefghi02"}`), "application/json")), http.StatusBadGateway, "videoUnavailable")
	requireError(t, send(h, request(http.MethodPost, "/api/import", strings.NewReader(`{"url":"file:///private"}`), "application/json")), http.StatusBadRequest, "unsupportedVideoUrl")
}

func TestBoardKeepsUploadedImageAfterSourceLayoutIsDeleted(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	png := fixtureImage(t)
	upload := send(h, request(http.MethodPost, "/api/image", bytes.NewReader(png), "image/png"))
	if upload.Code != http.StatusOK {
		t.Fatalf("upload returned %d %s", upload.Code, upload.Body.String())
	}
	var result struct{ Image string }
	if err := json.Unmarshal(upload.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}

	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	placement := map[string]any{
		"id": "placement", "name": "Placement", "image": result.Image, "layoutId": "layout",
		"x": float64(-30), "y": float64(12), "width": float64(300), "height": float64(160),
	}
	layout := map[string]any{
		"id": "layout", "name": "Layout", "image": result.Image,
		"labels": []any{"favorite"}, "publisher": "", "url": "", "custom": "optional",
	}
	state["layouts"] = []any{layout}
	state["boards"] = []any{map[string]any{"id": "board", "name": "Board", "items": []any{placement}}}
	created := stateResponse(t, saveState(t, h, state))
	created["trash"] = []any{layout}
	requireError(t, saveState(t, h, created), http.StatusBadRequest, "invalidState")
	created["layouts"] = []any{}
	trashed := stateResponse(t, saveState(t, h, created))
	if !reflect.DeepEqual(trashed["trash"], []any{layout}) {
		t.Fatal("trash lost the layout or its optional data")
	}
	trashed["trash"] = []any{}
	stateResponse(t, saveState(t, h, trashed))

	reopened := openLibrary(t, dir, nil)
	persisted := stateResponse(t, send(reopened, request(http.MethodGet, "/api/state", nil, "")))
	items := persisted["boards"].([]any)[0].(map[string]any)["items"]
	if !reflect.DeepEqual(items, []any{placement}) {
		t.Errorf("placement was lost after reopening: %#v", items)
	}
	image := send(reopened, request(http.MethodGet, result.Image, nil, ""))
	if image.Code != http.StatusOK || !bytes.Equal(image.Body.Bytes(), png) {
		t.Errorf("image was lost after reopening: %d", image.Code)
	}
}

func TestImageRouteRejectsFilesThatDoNotMatchTheirAddress(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	filename := strings.Repeat("a", 64) + ".png"
	if err := os.WriteFile(filepath.Join(dir, "images", filename), fixtureImage(t), 0600); err != nil {
		t.Fatal(err)
	}
	requireError(t, send(h, request(http.MethodGet, "/images/"+filename, nil, "")), http.StatusNotFound, "notFound")
}

func TestImageRouteRejectsSymlinksToPrivateFiles(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	png := fixtureImage(t)
	filename := fmt.Sprintf("%x.png", sha256.Sum256(png))
	target := filepath.Join(dir, "private.png")
	if err := os.WriteFile(target, png, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(dir, "images", filename)); err != nil {
		if runtime.GOOS == "windows" {
			t.Skip("creating symlinks requires additional permission on Windows")
		}
		t.Fatal(err)
	}
	requireError(t, send(h, request(http.MethodGet, "/images/"+filename, nil, "")), http.StatusNotFound, "notFound")
}
