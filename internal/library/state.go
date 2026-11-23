package library

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

const defaultState = `{
  "revision": 0,
  "labels": [
    {"id": "favorite", "name": "Favorite"},
    {"id": "gaming", "name": "Gaming"},
    {"id": "podcast", "name": "Podcast"},
    {"id": "web", "name": "Web design"},
    {"id": "essay", "name": "Video essay"},
    {"id": "tutorial", "name": "Tutorial"}
  ],
  "layouts": [],
  "trash": [],
  "boards": [],
  "settings": {"theme": "light", "language": null}
}`

const maxSafeRevision = 1<<53 - 1

var (
	imagePath = regexp.MustCompile(`^/images/[a-f0-9]{64}\.(?:jpg|png|webp|gif|avif|bmp)$`)
	urlScheme = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
)

func encodeState(state map[string]any) ([]byte, error) {
	var data bytes.Buffer
	encoder := json.NewEncoder(&data)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(state); err != nil {
		return nil, err
	}
	if data.Len() > stateLimit {
		return nil, &APIError{"invalidRequest", http.StatusRequestEntityTooLarge}
	}
	return data.Bytes(), nil
}

func (s *library) saveState(draft map[string]any) ([]byte, error) {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()

	if _, ok := draft["trash"]; !ok {
		draft["trash"] = s.trash
	}
	revision, ok := validState(draft)
	if !ok || revision == maxSafeRevision {
		return nil, &APIError{"invalidState", http.StatusBadRequest}
	}
	if revision != s.revision {
		return nil, &APIError{"revisionConflict", http.StatusConflict}
	}
	saved := map[string]any{
		"revision": revision + 1, "labels": draft["labels"],
		"layouts": draft["layouts"], "trash": draft["trash"], "boards": draft["boards"],
		"settings": draft["settings"],
	}
	data, err := encodeState(saved)
	if err != nil {
		return nil, err
	}
	root, err := openPrivateDir(s.dataDir)
	if err != nil {
		return nil, err
	}
	defer root.Close()

	// Serialize the state commit and image removal with uploads and readers.
	s.imageMu.Lock()
	defer s.imageMu.Unlock()
	if err := atomicWrite(root, "state.json", data); err != nil {
		return nil, err
	}

	refs := referencedImages(saved)
	s.attachUploads(refs)
	nextTrash := saved["trash"].([]any)
	s.reclaimRemovedTrashRasters(root, nextTrash, refs)
	s.revision = revision + 1
	s.trash = nextTrash
	s.snapshot = data
	s.imageRefs = refs
	return data, nil
}

type imageReference struct {
	path, id, boardID string
	usesUpload        bool
}

// referencedImages expects a validated state. Layouts and Trash share IDs, so
// moving a layout does not claim an upload of the same image.
func referencedImages(state map[string]any) map[imageReference]struct{} {
	refs := make(map[imageReference]struct{})
	add := func(items []any, boardID string) {
		for _, value := range items {
			item := value.(map[string]any)
			refs[imageReference{
				path: item["image"].(string), id: item["id"].(string), boardID: boardID,
				usesUpload: boardID == "" || item["layoutId"] == nil,
			}] = struct{}{}
		}
	}
	add(state["layouts"].([]any), "")
	add(state["trash"].([]any), "")
	for _, value := range state["boards"].([]any) {
		board := value.(map[string]any)
		add(board["items"].([]any), board["id"].(string))
	}
	return refs
}

func liveImagePaths(refs map[imageReference]struct{}) map[string]struct{} {
	paths := make(map[string]struct{}, len(refs))
	for ref := range refs {
		paths[ref.path] = struct{}{}
	}
	return paths
}

func (s *library) attachUploads(refs map[imageReference]struct{}) {
	if len(s.pendingUploads) == 0 {
		return
	}
	for ref := range refs {
		if _, existed := s.imageRefs[ref]; !existed && ref.usesUpload {
			s.releasePendingUpload(ref.path)
		}
	}
}

func removedTrashImages(previous, next []any) map[string]struct{} {
	retainedIDs := make(map[string]struct{}, len(next))
	for _, value := range next {
		retainedIDs[value.(map[string]any)["id"].(string)] = struct{}{}
	}
	removed := make(map[string]struct{})
	for _, value := range previous {
		entry := value.(map[string]any)
		if _, retained := retainedIDs[entry["id"].(string)]; !retained {
			removed[entry["image"].(string)] = struct{}{}
		}
	}
	return removed
}

func validState(state map[string]any) (int64, bool) {
	revision, ok := finiteNumber(state["revision"])
	if !ok || revision < 0 || revision > maxSafeRevision || math.Trunc(revision) != revision {
		return 0, false
	}
	labels, ok := byID(state["labels"], func(item map[string]any) bool {
		pinned, present := item["pinned"]
		_, boolean := pinned.(bool)
		return !present || boolean
	})
	if _, hasFavorite := labels["favorite"]; !ok || !hasFavorite {
		return 0, false
	}
	validLayout := func(layout map[string]any) bool {
		_, publisherOK := layout["publisher"].(string)
		website, websiteOK := layout["url"].(string)
		return localImage(layout["image"]) && publisherOK && websiteOK && originalURL(website) &&
			knownLabels(layout["labels"], labels)
	}
	active, activeOK := byID(state["layouts"], validLayout)
	trash, trashOK := byID(state["trash"], validLayout)
	_, boardsOK := byID(state["boards"], func(board map[string]any) bool {
		_, ok := byID(board["items"], validPlacement)
		return ok
	})
	if !activeOK || !trashOK || !boardsOK || !validSettings(state["settings"], labels) {
		return 0, false
	}
	for id := range active {
		if _, duplicate := trash[id]; duplicate {
			return 0, false
		}
	}
	return int64(revision), true
}

func validSettings(value any, labels map[string]struct{}) bool {
	settings, ok := value.(map[string]any)
	if !ok || (settings["theme"] != "light" && settings["theme"] != "dark") {
		return false
	}
	language, ok := settings["language"]
	if !ok || (language != nil && language != "en" && language != "zh-Hant") {
		return false
	}
	if automatic, present := settings["autoCheckUpdates"]; present {
		if _, ok := automatic.(bool); !ok {
			return false
		}
	}
	collections := settings["collections"]
	if collections == nil {
		return true
	}
	_, ok = byID(collections, func(item map[string]any) bool {
		_, hasQuery := item["query"].(string)
		ratio, _ := item["ratio"].(string)
		switch ratio {
		case "any", "16:9", "landscape", "square", "portrait":
			return hasQuery && knownLabels(item["labelIds"], labels)
		default:
			return false
		}
	})
	return ok
}

func byID(value any, valid func(map[string]any) bool) (map[string]struct{}, bool) {
	array, ok := value.([]any)
	if !ok {
		return nil, false
	}
	seen := make(map[string]struct{}, len(array))
	for _, value := range array {
		item, ok := value.(map[string]any)
		if !ok {
			return nil, false
		}
		id, idOK := nonemptyString(item["id"])
		_, nameOK := nonemptyString(item["name"])
		if _, duplicate := seen[id]; !idOK || !nameOK || duplicate || !valid(item) {
			return nil, false
		}
		seen[id] = struct{}{}
	}
	return seen, true
}

func knownLabels(value any, labels map[string]struct{}) bool {
	array, ok := value.([]any)
	if !ok {
		return false
	}
	for _, value := range array {
		id, ok := value.(string)
		if _, exists := labels[id]; !ok || !exists {
			return false
		}
	}
	return true
}

func validPlacement(item map[string]any) bool {
	layoutID, present := item["layoutId"]
	_, nonempty := nonemptyString(layoutID)
	if !present || (layoutID != nil && !nonempty) || !localImage(item["image"]) {
		return false
	}
	for _, key := range []string{"x", "y", "width", "height"} {
		number, ok := finiteNumber(item[key])
		if !ok || ((key == "width" || key == "height") && number <= 0) {
			return false
		}
	}
	return true
}

func localImage(value any) bool {
	image, ok := value.(string)
	return ok && imagePath.MatchString(image)
}

func nonemptyString(value any) (string, bool) {
	text, ok := value.(string)
	return text, ok && strings.TrimSpace(text) != ""
}

func finiteNumber(value any) (float64, bool) {
	number, ok := value.(json.Number)
	if !ok {
		return 0, false
	}
	f, err := number.Float64()
	return f, err == nil && !math.IsNaN(f) && !math.IsInf(f, 0)
}

func originalURL(value string) bool {
	if value == "" {
		return true
	}
	target, err := url.Parse(value)
	return err == nil && (target.Scheme == "https" || target.Scheme == "http") &&
		target.Hostname() != "" && target.User == nil && target.Opaque == ""
}

func validVideoInput(value string) bool {
	if !urlScheme.MatchString(value) {
		value = "https://" + value
	}
	return originalURL(value)
}
