package library

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"runtime"
	"strings"
)

func prepareDataDir(path string) (*os.Root, error) {
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	root, err := openPrivateDir(path)
	if err != nil {
		return nil, err
	}
	if err := root.Mkdir("images", 0700); err != nil && !errors.Is(err, fs.ErrExist) {
		root.Close()
		return nil, err
	}
	images, err := openImageRoot(root)
	if err != nil {
		root.Close()
		return nil, err
	}
	images.Close()
	return root, nil
}

func openPrivateDir(path string) (*os.Root, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("data path must be a directory")
	}
	root, err := os.OpenRoot(path)
	if err != nil {
		return nil, err
	}
	return checkedDir(root, info)
}

func openImageRoot(data *os.Root) (*os.Root, error) {
	info, err := data.Lstat("images")
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errors.New("image path must be a directory")
	}
	root, err := data.OpenRoot("images")
	if err != nil {
		return nil, err
	}
	return checkedDir(root, info)
}

func checkedDir(root *os.Root, expected fs.FileInfo) (*os.Root, error) {
	info, err := root.Stat(".")
	if err == nil && !os.SameFile(expected, info) {
		err = errors.New("data directory changed while opening")
	}
	if err == nil && runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		err = root.Chmod(".", 0700)
	}
	if err != nil {
		root.Close()
		return nil, err
	}
	return root, nil
}

var errInvalidPrivateFile = errors.New("stored file is not a regular file")

func readPrivateFile(root *os.Root, name string, limit int64) ([]byte, error) {
	expected, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !expected.Mode().IsRegular() {
		return nil, errInvalidPrivateFile
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !os.SameFile(expected, info) {
		return nil, errInvalidPrivateFile
	}
	if info.Size() > limit {
		return nil, errors.New("stored file exceeds size limit")
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err == nil && int64(len(data)) > limit {
		return nil, errors.New("stored file exceeds size limit")
	}
	return data, err
}

func atomicWrite(root *os.Root, name string, data []byte) error {
	temporary := ".write-" + rand.Text()
	file, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer root.Remove(temporary)

	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	// Root.Rename replaces the destination within the same directory on
	// both platforms. Windows uses a handle-relative rename with replacement.
	return root.Rename(temporary, name)
}

var rasterMIME = map[string]string{
	"jpg":  "image/jpeg",
	"png":  "image/png",
	"webp": "image/webp",
	"gif":  "image/gif",
	"avif": "image/avif",
	"bmp":  "image/bmp",
}

// RasterExtension identifies the supported raster formats from their signatures
// and checks an optional declared content type.
func RasterExtension(data []byte, declared string) (extension string, ok bool) {
	switch {
	case len(data) >= 24 && bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")) && string(data[12:16]) == "IHDR":
		extension = "png"
	case len(data) >= 4 && bytes.HasPrefix(data, []byte("\xff\xd8\xff")):
		extension = "jpg"
	case len(data) >= 16 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		extension = "webp"
	case len(data) >= 14 && (string(data[:6]) == "GIF87a" || string(data[:6]) == "GIF89a"):
		extension = "gif"
	case len(data) >= 16 && string(data[4:8]) == "ftyp" && (string(data[8:12]) == "avif" || string(data[8:12]) == "avis"):
		extension = "avif"
	case len(data) >= 26 && string(data[:2]) == "BM":
		extension = "bmp"
	default:
		return "", false
	}

	mediaType := bareMIME(declared)
	switch mediaType {
	case "image/jpg":
		mediaType = "image/jpeg"
	case "image/x-png":
		mediaType = "image/png"
	case "image/x-ms-bmp":
		mediaType = "image/bmp"
	}
	if mediaType == "" || mediaType == "application/octet-stream" || mediaType == rasterMIME[extension] {
		return extension, true
	}
	return "", false
}

func (s *library) saveRaster(data []byte, mediaType string) (string, error) {
	if len(data) > imageLimit {
		return "", &APIError{"imageTooLarge", http.StatusRequestEntityTooLarge}
	}
	extension, ok := RasterExtension(data, mediaType)
	if !ok {
		return "", &APIError{"unsupportedImage", http.StatusUnsupportedMediaType}
	}
	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:]) + "." + extension

	s.imageMu.Lock()
	defer s.imageMu.Unlock()
	root, err := s.images()
	if err != nil {
		return "", err
	}
	defer root.Close()
	existing, err := readPrivateFile(root, name, imageLimit)
	if err != nil || !bytes.Equal(existing, data) {
		if err := atomicWrite(root, name, data); err != nil {
			return "", err
		}
	}
	path := "/images/" + name
	// Uploads and imports return before their state PUT, even for a digest
	// already attached to a layout.
	s.pendingUploads[path]++
	return path, nil
}

func (s *library) releaseImages(w http.ResponseWriter, r *http.Request) error {
	body, err := requestObject(w, r, imageReleaseLimit, "invalidRequest")
	if err != nil {
		return err
	}
	paths, ok := body["images"].([]any)
	if !ok {
		return &APIError{"invalidRequest", http.StatusBadRequest}
	}
	for _, path := range paths {
		if !localImage(path) {
			return &APIError{"invalidRequest", http.StatusBadRequest}
		}
	}

	s.imageMu.Lock()
	for _, path := range paths {
		s.releasePendingUpload(path.(string))
	}
	s.imageMu.Unlock()
	writeJSON(w, r, http.StatusOK, []byte("{}"))
	return nil
}

// releasePendingUpload requires the image lock.
func (s *library) releasePendingUpload(path string) {
	switch n := s.pendingUploads[path]; {
	case n == 1:
		delete(s.pendingUploads, path)
	case n > 1:
		s.pendingUploads[path] = n - 1
	}
}

func (s *library) images() (*os.Root, error) {
	data, err := openPrivateDir(s.dataDir)
	if err != nil {
		return nil, err
	}
	defer data.Close()
	return openImageRoot(data)
}

func (s *library) readRaster(name string) ([]byte, error) {
	s.imageMu.RLock()
	defer s.imageMu.RUnlock()

	root, err := s.images()
	if err != nil {
		return nil, err
	}
	defer root.Close()
	data, err := readPrivateFile(root, name, imageLimit)
	if errors.Is(err, errInvalidPrivateFile) {
		return nil, fs.ErrNotExist
	}
	if err != nil {
		return nil, err
	}
	if !matchesRasterAddress(name, data) {
		return nil, fs.ErrNotExist
	}
	return data, nil
}

func matchesRasterAddress(name string, data []byte) bool {
	ext, ok := RasterExtension(data, "")
	if !ok {
		return false
	}
	sum := sha256.Sum256(data)
	return name == hex.EncodeToString(sum[:])+"."+ext
}

func reclaimOrphanedRasters(root *os.Root, live map[string]struct{}) {
	images, err := openImageRoot(root)
	if err != nil {
		return
	}
	defer images.Close()
	files, err := fs.ReadDir(images.FS(), ".")
	if err != nil {
		return
	}
	for _, file := range files {
		name := file.Name()
		path := "/images/" + name
		if _, referenced := live[path]; !referenced && file.Type().IsRegular() && imagePath.MatchString(path) {
			reclaimRaster(images, name)
		}
	}
}

// Only permanent Trash deletions reclaim files during the session. The
// whiteboard may still need removed images for its in-memory undo history.
func (s *library) reclaimRemovedTrashRasters(root *os.Root, nextTrash []any, refs map[imageReference]struct{}) {
	removed := removedTrashImages(s.trash, nextTrash)
	if len(removed) == 0 {
		return
	}
	images, err := openImageRoot(root)
	if err != nil {
		return
	}
	defer images.Close()
	live := liveImagePaths(refs)
	for path := range removed {
		if _, referenced := live[path]; !referenced && s.pendingUploads[path] == 0 {
			reclaimRaster(images, strings.TrimPrefix(path, "/images/"))
		}
	}
}

func reclaimRaster(images *os.Root, name string) {
	expected, err := images.Lstat(name)
	if err != nil || !expected.Mode().IsRegular() {
		return
	}
	data, err := readPrivateFile(images, name, imageLimit)
	if err != nil || !matchesRasterAddress(name, data) {
		return
	}
	info, err := images.Lstat(name)
	if err == nil && os.SameFile(expected, info) {
		// A failed unlink can be retried on next launch.
		_ = images.Remove(name)
	}
}
