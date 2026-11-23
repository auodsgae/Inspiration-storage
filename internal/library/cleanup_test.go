package library

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestPermanentDeletionKeepsRasterUntilLastTrashReferenceIsGone(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	image := uploadPNG(t, h, fixtureImage(t))
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	first, second := imageLayout("first", image), imageLayout("second", image)
	state["layouts"], state["trash"] = []any{first}, []any{second}
	state = stateResponse(t, saveState(t, h, state))

	state["trash"] = []any{}
	state = stateResponse(t, saveState(t, h, state))
	requireRaster(t, h, image)

	state["layouts"], state["trash"] = []any{}, []any{first, second}
	state = stateResponse(t, saveState(t, h, state))
	state["trash"] = []any{second}
	state = stateResponse(t, saveState(t, h, state))
	requireRaster(t, h, image)

	state["trash"] = []any{}
	stateResponse(t, saveState(t, h, state))
	requireRasterDeleted(t, h, dir, image)
}

func TestFailedStateWriteKeepsPermanentlyDeletedRaster(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	image := uploadPNG(t, h, fixtureImage(t))
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	state["trash"] = []any{imageLayout("deleted", image)}
	state = stateResponse(t, saveState(t, h, state))

	statePath := filepath.Join(dir, "state.json")
	backup := filepath.Join(dir, "backup.json")
	if err := os.Rename(statePath, backup); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(statePath, 0700); err != nil {
		t.Fatal(err)
	}
	state["trash"] = []any{}
	requireError(t, saveState(t, h, state), http.StatusInternalServerError, "serverError")
	requireRaster(t, h, image)
	persisted := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	if persisted["revision"] != state["revision"] || len(persisted["trash"].([]any)) != 1 {
		t.Fatalf("failed write changed the state: %v", persisted)
	}

	if err := os.Remove(statePath); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(backup, statePath); err != nil {
		t.Fatal(err)
	}
	stateResponse(t, saveState(t, h, state))
	requireRasterDeleted(t, h, dir, image)
}

func TestStartupReclaimsOnlyUnreferencedContentAddressedRasters(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	data := fixtureImage(t)
	live := uploadPNG(t, h, data)
	orphan := uploadPNG(t, h, fixturePNG(t, 2))
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	state["trash"] = []any{imageLayout("kept", live)}
	stateResponse(t, saveState(t, h, state))

	images := filepath.Join(dir, "images")
	nonRaster := []byte("not a raster")
	foreign := map[string][]byte{
		"notes.png":                                     data,
		strings.Repeat("a", 64) + ".png":                data,
		fmt.Sprintf("%x.png", sha256.Sum256(nonRaster)): nonRaster,
	}
	for name, content := range foreign {
		if err := os.WriteFile(filepath.Join(images, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}

	linkedData := fixturePNG(t, 3)
	target := filepath.Join(dir, "outside.png")
	if err := os.WriteFile(target, linkedData, 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(images, fmt.Sprintf("%x.png", sha256.Sum256(linkedData)))
	linkErr := os.Symlink(target, link)
	if linkErr != nil && runtime.GOOS != "windows" {
		t.Fatal(linkErr)
	}

	reopened := openLibrary(t, dir, nil)
	requireRaster(t, reopened, live)
	requireRasterDeleted(t, reopened, dir, orphan)
	for name, content := range foreign {
		if stored, err := os.ReadFile(filepath.Join(images, name)); err != nil || !bytes.Equal(stored, content) {
			t.Errorf("foreign file %s changed: %v", name, err)
		}
	}
	if linkErr == nil {
		if got, err := os.Readlink(link); err != nil || got != target {
			t.Errorf("symlink changed: %s %v", got, err)
		}
	}
}

func TestInvalidStatePreventsStartupCleanup(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	image := uploadPNG(t, h, fixtureImage(t))
	if err := os.WriteFile(filepath.Join(dir, "state.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(dir, testAssets, nil); err == nil {
		t.Fatal("opening invalid state succeeded")
	}
	requireRaster(t, h, image)
}

func TestBoardImageRemovalKeepsRasterForUndoUntilRestart(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	image := uploadPNG(t, h, fixtureImage(t))
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	placement := map[string]any{
		"id": "placement", "name": "Placement", "image": image, "layoutId": nil,
		"x": 0, "y": 0, "width": 300, "height": 160,
	}
	board := map[string]any{"id": "board", "name": "Board", "items": []any{placement}}
	state["boards"] = []any{board}
	state = stateResponse(t, saveState(t, h, state))

	board["items"] = []any{}
	state["boards"] = []any{board}
	state = stateResponse(t, saveState(t, h, state))
	requireRaster(t, h, image)

	board["items"] = []any{placement}
	state["boards"] = []any{board}
	state = stateResponse(t, saveState(t, h, state))
	requireRaster(t, h, image)

	board["items"] = []any{}
	state["boards"] = []any{board}
	stateResponse(t, saveState(t, h, state))
	reopened := openLibrary(t, dir, nil)
	requireRasterDeleted(t, reopened, dir, image)
}

func TestPendingUploadSurvivesDeletionOfAnotherReference(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	data := fixtureImage(t)
	image := uploadPNG(t, h, data)
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	state["trash"] = []any{imageLayout("old", image)}
	stale := stateResponse(t, saveState(t, h, state))

	if duplicate := uploadPNG(t, h, data); duplicate != image {
		t.Fatalf("duplicate image path %q, want %q", duplicate, image)
	}
	// A linked placement copies a layout image without making an upload.
	stale["boards"] = []any{map[string]any{"id": "board", "name": "Board", "items": []any{
		map[string]any{
			"id": "linked", "name": "Linked layout", "image": image, "layoutId": "old",
			"x": 0, "y": 0, "width": 1, "height": 1,
		},
	}}}
	state = stateResponse(t, saveState(t, h, stale))
	stale["trash"] = []any{}
	requireError(t, saveState(t, h, stale), http.StatusConflict, "revisionConflict")
	requireRaster(t, h, image)
	state["boards"], state["trash"] = []any{}, []any{}
	state = stateResponse(t, saveState(t, h, state))
	requireRaster(t, h, image)

	layout := imageLayout("new", image)
	stale["trash"], stale["layouts"] = []any{}, []any{layout}
	requireError(t, saveState(t, h, stale), http.StatusConflict, "revisionConflict")
	requireRaster(t, h, image)

	state["layouts"] = []any{layout}
	state = stateResponse(t, saveState(t, h, state))
	state["layouts"], state["trash"] = []any{}, []any{layout}
	state = stateResponse(t, saveState(t, h, state))
	state["trash"] = []any{}
	stateResponse(t, saveState(t, h, state))
	requireRasterDeleted(t, h, dir, image)
}

func TestReleasingAnUnusedDuplicateUploadAllowsPermanentDeletion(t *testing.T) {
	dir := t.TempDir()
	h := openLibrary(t, dir, nil)
	data := fixtureImage(t)
	image := uploadPNG(t, h, data)
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	state["trash"] = []any{imageLayout("old", image)}
	state = stateResponse(t, saveState(t, h, state))
	uploadPNG(t, h, data)

	release := func(body string) *http.Request {
		return request(http.MethodPost, "/api/image/release", strings.NewReader(body), "application/json")
	}
	body := fmt.Sprintf(`{"images":[%q]}`, image)
	unmarked := release(body)
	unmarked.Header.Del("X-Inspiration-Request")
	requireError(t, send(h, unmarked), http.StatusBadRequest, "invalidRequest")
	requireError(t, send(h, release(fmt.Sprintf(`{"images":[%q,"/private.png"]}`, image))), http.StatusBadRequest, "invalidRequest")
	tooLarge := release(body)
	tooLarge.ContentLength = 64*1024 + 1
	requireError(t, send(h, tooLarge), http.StatusRequestEntityTooLarge, "invalidRequest")
	stateResponse(t, send(h, release(body)))
	requireRaster(t, h, image)

	state["trash"] = []any{}
	stateResponse(t, saveState(t, h, state))
	requireRasterDeleted(t, h, dir, image)
}

func TestConcurrentUploadAndPermanentDeletionKeepPendingRaster(t *testing.T) {
	h := openLibrary(t, t.TempDir(), nil)
	data := fixtureImage(t)
	image := uploadPNG(t, h, data)
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	state["trash"] = []any{imageLayout("old", image)}
	state = stateResponse(t, saveState(t, h, state))
	state["trash"] = []any{}
	payload, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}

	start := make(chan struct{})
	responses := make(chan *httptest.ResponseRecorder, 2)
	for _, req := range []*http.Request{
		request(http.MethodPut, "/api/state", bytes.NewReader(payload), "application/json"),
		request(http.MethodPost, "/api/image", bytes.NewReader(data), "image/png"),
	} {
		go func() {
			<-start
			responses <- send(h, req)
		}()
	}
	close(start)
	for range 2 {
		stateResponse(t, <-responses)
	}
	requireRaster(t, h, image)
}

func uploadPNG(t *testing.T, h http.Handler, data []byte) string {
	t.Helper()
	upload := send(h, request(http.MethodPost, "/api/image", bytes.NewReader(data), "image/png"))
	var result struct{ Image string }
	if upload.Code != http.StatusOK || json.Unmarshal(upload.Body.Bytes(), &result) != nil || result.Image == "" {
		t.Fatalf("upload returned %d %s", upload.Code, upload.Body.String())
	}
	return result.Image
}

func requireRaster(t *testing.T, h http.Handler, image string) {
	t.Helper()
	if result := send(h, request(http.MethodGet, image, nil, "")); result.Code != http.StatusOK {
		t.Fatalf("raster %s returned %d %s", image, result.Code, result.Body.String())
	}
}

func imageLayout(id, image string) map[string]any {
	return map[string]any{
		"id": id, "name": id, "image": image, "publisher": "", "url": "", "labels": []any{},
	}
}

func fixturePNG(t *testing.T, width int) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, width, 1))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func requireRasterDeleted(t *testing.T, h http.Handler, dir, image string) {
	t.Helper()
	requireError(t, send(h, request(http.MethodGet, image, nil, "")), http.StatusNotFound, "notFound")
	if _, err := os.Lstat(filepath.Join(dir, strings.TrimPrefix(image, "/"))); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("expected file %s to be removed, got %v", image, err)
	}
}
