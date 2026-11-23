package updates

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const sampleRelease = `{
	"tag_name": "v2.10.3",
	"draft": false,
	"prerelease": false,
	"html_url": "https://unrelated.example/release",
	"assets": [
		{
			"name": "inspiration-storage-2.10.3.dmg",
			"state": "uploaded",
			"browser_download_url": "https://github.com/auodsgae/Inspiration-storage/releases/download/v2.10.3/inspiration-storage-2.10.3.dmg"
		},
		{
			"name": "inspiration-storage-setup-2.10.3-amd64.exe",
			"state": "uploaded",
			"browser_download_url": "https://github.com/auodsgae/Inspiration-storage/releases/download/v2.10.3/inspiration-storage-setup-2.10.3-amd64.exe"
		},
		{
			"name": "inspiration-storage-setup-2.10.3-arm64.exe",
			"state": "uploaded",
			"browser_download_url": "https://github.com/auodsgae/Inspiration-storage/releases/download/v2.10.3/inspiration-storage-setup-2.10.3-arm64.exe"
		}
	]
}`

const sampleReleaseURL = "https://github.com/auodsgae/Inspiration-storage/releases/tag/v2.10.3"

func TestCheckComparesVersionsNumericallyAndSelectsThePlatformInstaller(t *testing.T) {
	cases := []struct {
		name, current, latestTag, goos, arch, asset string
		available                                   bool
	}{
		{"newer minor on Apple Silicon", "2.9.100", "v2.10.3", "darwin", "arm64", "inspiration-storage-2.10.3.dmg", true},
		{"same tag with v prefix", "v2.10.3", "v2.10.3", "darwin", "arm64", "", false},
		{"older patch", "2.10.10", "v2.10.3", "darwin", "arm64", "", false},
		{"older major", "3.0.0", "v2.10.3", "darwin", "arm64", "", false},
		{"newer patch on Intel Mac", "2.10.2", "v2.10.3", "darwin", "amd64", "inspiration-storage-2.10.3.dmg", true},
		{"Windows x64", "1.30.1", "v2.10.3", "windows", "amd64", "inspiration-storage-setup-2.10.3-amd64.exe", true},
		{"Windows ARM64", "1.30.1", "v2.10.3", "windows", "arm64", "inspiration-storage-setup-2.10.3-arm64.exe", true},
		{"unsupported OS", "1.30.1", "v2.10.3", "linux", "amd64", "", true},
		{"unsupported architecture", "1.30.1", "v2.10.3", "windows", "386", "", true},
		{"large version components", "2.99999999999999999999.3", "v2.100000000000000000000.3", "linux", "amd64", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := releaseFixture(http.StatusOK, strings.Replace(sampleRelease, `"v2.10.3"`, `"`+tc.latestTag+`"`, 1))
			got, err := check(context.Background(), client, tc.current, tc.goos, tc.arch)
			if err != nil {
				t.Fatal(err)
			}
			want := Info{
				Current:    strings.TrimPrefix(tc.current, "v"),
				Latest:     strings.TrimPrefix(tc.latestTag, "v"),
				Available:  tc.available,
				ReleaseURL: "https://github.com/auodsgae/Inspiration-storage/releases/tag/" + tc.latestTag,
			}
			if tc.asset != "" {
				want.DownloadURL = "https://github.com/auodsgae/Inspiration-storage/releases/download/v2.10.3/" + tc.asset
			}
			if got != want {
				t.Errorf("check returned %+v, want %+v", got, want)
			}
		})
	}
}

func TestCheckDoesNotOfferUnverifiedInstallers(t *testing.T) {
	assetURL := "https://github.com/auodsgae/Inspiration-storage/releases/download/v2.10.3/inspiration-storage-2.10.3.dmg"
	cases := []struct {
		name, original, replacement string
	}{
		{"different host", assetURL, "https://unrelated.example/inspiration-storage-2.10.3.dmg"},
		{"different repository", assetURL, strings.Replace(assetURL, "auodsgae/Inspiration-storage", "someone/another-repo", 1)},
		{"different tag", assetURL, strings.Replace(assetURL, "v2.10.3", "v2.9.0", 1)},
		{"query string", assetURL, assetURL + "?redirect=https://unrelated.example"},
		{"asset still uploading", `"state": "uploaded"`, `"state": "open"`},
		{"different filename", `"name": "inspiration-storage-2.10.3.dmg"`, `"name": "other-2.10.3.dmg"`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := releaseFixture(http.StatusOK, strings.Replace(sampleRelease, tc.original, tc.replacement, 1))
			got, err := check(context.Background(), client, "1.0.0", "darwin", "arm64")
			want := Info{Current: "1.0.0", Latest: "2.10.3", Available: true, ReleaseURL: sampleReleaseURL}
			if err != nil || got != want {
				t.Errorf("check returned %+v, %v, want %+v without error", got, err, want)
			}
		})
	}
}

func TestCheckRejectsInvalidReleaseResponses(t *testing.T) {
	cases := []struct {
		name, body string
		status     int
	}{
		{"draft", strings.Replace(sampleRelease, `"draft": false`, `"draft": true`, 1), http.StatusOK},
		{"prerelease", strings.Replace(sampleRelease, `"prerelease": false`, `"prerelease": true`, 1), http.StatusOK},
		{"missing stable flag", strings.Replace(sampleRelease, `"prerelease": false,`, "", 1), http.StatusOK},
		{"missing v prefix", strings.Replace(sampleRelease, `"v2.10.3"`, `"2.10.3"`, 1), http.StatusOK},
		{"leading zero", strings.Replace(sampleRelease, `"v2.10.3"`, `"v2.010.3"`, 1), http.StatusOK},
		{"tag with prerelease suffix", strings.Replace(sampleRelease, `"v2.10.3"`, `"v2.10.3-beta"`, 1), http.StatusOK},
		{"tag with path", strings.Replace(sampleRelease, `"v2.10.3"`, `"v2.10.3/../download"`, 1), http.StatusOK},
		{"malformed JSON", "{", http.StatusOK},
		{"trailing JSON", sampleRelease + " {}", http.StatusOK},
		{"oversized response", sampleRelease + strings.Repeat(" ", 1<<20), http.StatusOK},
		{"API rate limited", sampleRelease, http.StatusForbidden},
		{"release missing", sampleRelease, http.StatusNotFound},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := check(context.Background(), releaseFixture(tc.status, tc.body), "1.0.0", "darwin", "arm64")
			if err == nil || got != (Info{Current: "1.0.0"}) {
				t.Errorf("check returned %+v, %v, want only Current and an error", got, err)
			}
		})
	}
}

func TestCheckUsesAnAnonymousRequestAndDoesNotFollowRedirects(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "https://user:password@proxy.example")
	client := newReleaseClient()
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil || client.Jar != nil {
		t.Fatal("release requests must use a dedicated transport without proxies or cookies")
	}
	if client.Timeout <= 0 || client.Timeout > 10*time.Second {
		t.Errorf("request timeout is %s, want a positive timeout within 10 seconds", client.Timeout)
	}
	calls := 0
	client.Transport = releaseTransport(func(request *http.Request) (*http.Response, error) {
		calls++
		if request.Method != http.MethodGet ||
			request.URL.String() != "https://api.github.com/repos/auodsgae/Inspiration-storage/releases/latest" ||
			request.Body != nil {
			t.Errorf("unexpected release request %s %s, body %v", request.Method, request.URL, request.Body)
		}
		want, _ := json.Marshal(http.Header{
			"Accept":     {"application/vnd.github+json"},
			"User-Agent": {"Inspiration-Storage"},
		})
		got, err := json.Marshal(request.Header)
		if err != nil || string(got) != string(want) {
			t.Errorf("request headers %s, want %s", got, want)
		}
		return &http.Response{
			StatusCode: http.StatusFound,
			Header:     http.Header{"Location": {"https://unrelated.example/"}},
			Body:       io.NopCloser(strings.NewReader(sampleRelease)),
		}, nil
	})
	got, err := check(context.Background(), client, "919.587.383", "darwin", "arm64")
	if err == nil || got != (Info{Current: "919.587.383"}) || calls != 1 {
		t.Errorf("check returned %+v, %v, after %d requests, want a single anonymous attempt and an error", got, err, calls)
	}
}

func TestCheckRejectsInvalidCurrentVersionWithoutANetworkRequest(t *testing.T) {
	client := newReleaseClient()
	client.Transport = releaseTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("a release request was sent with an invalid current version")
		return nil, nil
	})
	if got, err := check(context.Background(), client, "development", "darwin", "arm64"); err == nil || got != (Info{}) {
		t.Errorf("check returned %+v, %v, want an empty result and an error", got, err)
	}
}

type releaseTransport func(*http.Request) (*http.Response, error)

func (transport releaseTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func releaseFixture(status int, body string) *http.Client {
	client := newReleaseClient()
	client.Transport = releaseTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body))}, nil
	})
	return client
}
