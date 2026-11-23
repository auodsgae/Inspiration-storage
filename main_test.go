package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestLibraryDirUsesShortNameForFreshInstall(t *testing.T) {
	root := t.TempDir()
	path, err := libraryDirIn(root)
	if err != nil || path != filepath.Join(root, "inspiration-storage") {
		t.Fatalf("got %q, %v", path, err)
	}
}

func TestLibraryDirMovesAnExistingLibrary(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "com.auodsgae.inspiration-storage")
	if err := os.MkdirAll(filepath.Join(old, "images"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"state.json", "images/reference.png"} {
		if err := os.WriteFile(filepath.Join(old, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	path, err := libraryDirIn(root)
	if err != nil || path != filepath.Join(root, "inspiration-storage") {
		t.Fatalf("got %q, %v", path, err)
	}
	for _, name := range []string{"state.json", "images/reference.png"} {
		data, err := os.ReadFile(filepath.Join(path, name))
		if err != nil || string(data) != name {
			t.Fatalf("migrated %s contains %q, %v", name, data, err)
		}
	}
	if _, err := os.Lstat(old); !os.IsNotExist(err) {
		t.Fatalf("old library directory still exists or could not be inspected: %v", err)
	}
}

func TestLibraryDirKeepsBothLibrariesWhenDestinationExists(t *testing.T) {
	root := t.TempDir()
	old := filepath.Join(root, "com.auodsgae.inspiration-storage")
	current := filepath.Join(root, "inspiration-storage")
	for _, path := range []string{old, current} {
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(path, "state.json"), []byte(filepath.Base(path)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	path, err := libraryDirIn(root)
	if err != nil || path != current {
		t.Fatalf("got %q, %v", path, err)
	}
	for _, path := range []string{old, current} {
		data, err := os.ReadFile(filepath.Join(path, "state.json"))
		if err != nil || string(data) != filepath.Base(path) {
			t.Fatalf("library %s changed: %q, %v", filepath.Base(path), data, err)
		}
	}
}

func TestEmbeddedFrontendContainsOnlyApplicationFiles(t *testing.T) {
	want := []string{"app.js", "board.css", "board.js", "index.html", "library.js", "locale.js", "style.css"}
	files, err := fs.ReadDir(frontend, "public")
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(files))
	for _, file := range files {
		if file.IsDir() {
			t.Fatalf("unexpected embedded directory %s", file.Name())
		}
		got = append(got, file.Name())
	}
	if !slices.Equal(got, want) {
		t.Fatalf("embedded files = %v, want %v", got, want)
	}
}

func TestFrontendNavigationChecksTheCompleteOrigin(t *testing.T) {
	for _, value := range []string{"mygo://localhost/", "http://mygo.localhost/whiteboards"} {
		if !isFrontendURL(value) {
			t.Errorf("did not recognize application URL %q", value)
		}
	}
	for _, value := range []string{
		"https://mygo.localhost/", "http://mygo.localhost.example.com/", "http://mygo.localhost:80/",
		"mygo://name@localhost/", "mygo://localhost:80/", "file:///tmp/example.html",
		"https://example.com/", "javascript:alert(1)",
	} {
		if isFrontendURL(value) {
			t.Errorf("external URL recognized as internal %q", value)
		}
	}
}
