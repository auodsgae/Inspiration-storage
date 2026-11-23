package main

import (
	"io/fs"
	"slices"
	"testing"
)

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
