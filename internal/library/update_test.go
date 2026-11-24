package library

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestVersionRouteUsesBundledVersionWithoutChecking(t *testing.T) {
	h, err := New(t.TempDir(), testAssets, nil, UpdateEndpoint{
		Version: "1.2.3",
		Check: func(context.Context) (any, error) {
			t.Fatal("version route invoked update checker")
			return nil, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	w := send(h, request(http.MethodGet, "/api/version", nil, ""))
	got := stateResponse(t, w)
	if got["version"] != "1.2.3" || len(got) != 1 || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("version response was %v with headers %v", got, w.Header())
	}
	requireError(t, send(h, request(http.MethodPost, "/api/version", nil, "")), http.StatusMethodNotAllowed, "methodNotAllowed")
	requireError(t, send(h, request(http.MethodGet, "/api/version/", nil, "")), http.StatusNotFound, "notFound")
}

func TestUpdateRouteChecksOnlyNativeMarkedPosts(t *testing.T) {
	calls := 0
	h, err := New(t.TempDir(), testAssets, nil, UpdateEndpoint{
		Check: func(context.Context) (any, error) {
			calls++
			return map[string]string{"latestVersion": "1.2.4"}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	requireError(t, send(h, request(http.MethodGet, "/api/update", nil, "")), http.StatusMethodNotAllowed, "methodNotAllowed")
	unmarked := request(http.MethodPost, "/api/update", nil, "")
	unmarked.Header.Del("X-Inspiration-Request")
	requireError(t, send(h, unmarked), http.StatusBadRequest, "invalidRequest")
	crossOrigin := request(http.MethodPost, "/api/update", nil, "")
	crossOrigin.Header.Set("Origin", "https://example.com")
	requireError(t, send(h, crossOrigin), http.StatusBadRequest, "invalidRequest")
	if calls != 0 {
		t.Fatal("an unauthorized request called the update checker")
	}
	w := send(h, request(http.MethodPost, "/api/update", nil, ""))
	got := stateResponse(t, w)
	if got["latestVersion"] != "1.2.4" || calls != 1 || w.Header().Get("Cache-Control") != "private, no-store" {
		t.Fatalf("got %v with headers %v and %d checks", got, w.Header(), calls)
	}
}

func TestUpdateErrorUsesLocalizedKey(t *testing.T) {
	h, err := New(t.TempDir(), testAssets, nil, UpdateEndpoint{
		Check: func(context.Context) (any, error) {
			return nil, errors.New("internal network failure")
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	requireError(t, send(h, request(http.MethodPost, "/api/update", nil, "")), http.StatusBadGateway, "updateCheckFailed")
}

func TestUpdateInstallRequiresVersionedNativePostAndCanRetryFailure(t *testing.T) {
	calls := 0
	h, err := New(t.TempDir(), testAssets, nil, UpdateEndpoint{
		Install: func(_ context.Context, version string) error {
			calls++
			if version != "0.1.5" {
				t.Fatalf("install received version %q", version)
			}
			if calls == 1 {
				return errors.New("private updater error")
			}
			return nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	install := func(body string) *http.Request {
		return request(http.MethodPost, "/api/update/install", strings.NewReader(body), "application/json")
	}
	requireError(t, send(h, request(http.MethodGet, "/api/update/install", nil, "")), 405, "methodNotAllowed")
	req := install(`{"version":"0.1.5"}`)
	req.Header.Set("Origin", "https://example.com")
	requireError(t, send(h, req), 400, "invalidRequest")
	req = install(`{"version":"0.1.5"}`)
	req.Header.Del("X-Inspiration-Request")
	requireError(t, send(h, req), 400, "invalidRequest")
	requireError(t, send(h, install(`{"url":"https://example.com/file"}`)), 400, "invalidRequest")
	if calls != 0 {
		t.Fatal("an invalid request reached the installer")
	}
	requireError(t, send(h, install(`{"version":"0.1.5"}`)), 502, "updateInstallFailed")
	w := send(h, install(`{"version":"0.1.5"}`))
	if w.Code != http.StatusOK || stateResponse(t, w)["installed"] != true || calls != 2 {
		t.Fatalf("retry response: %s, calls: %d", w.Body, calls)
	}
	requireError(t, send(h, install(`{"version":"0.1.5"}`)), 409, "updateInstallBusy")
}

func TestOptionalAutomaticUpdateSettingMustBeBoolean(t *testing.T) {
	h := openLibrary(t, t.TempDir(), nil)
	state := stateResponse(t, send(h, request(http.MethodGet, "/api/state", nil, "")))
	settings := state["settings"].(map[string]any)
	for _, wrong := range []any{"false", nil, float64(1)} {
		settings["autoCheckUpdates"] = wrong
		requireError(t, saveState(t, h, state), http.StatusBadRequest, "invalidState")
	}
	settings["autoCheckUpdates"] = false
	saved := stateResponse(t, saveState(t, h, state))
	if saved["settings"].(map[string]any)["autoCheckUpdates"] != false {
		t.Fatalf("saved settings = %v", saved["settings"])
	}
}
