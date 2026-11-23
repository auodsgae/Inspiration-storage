package updates

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	latestReleaseAPI = "https://api.github.com/repos/auodsgae/Inspiration-storage/releases/latest"
	releasesURL      = "https://github.com/auodsgae/Inspiration-storage/releases"
	maxReleaseBytes  = 1 << 20
)

// Info describes the newest stable release and, when available, its installer for this device.
type Info struct {
	Current     string `json:"current"`
	Latest      string `json:"latest"`
	Available   bool   `json:"available"`
	DownloadURL string `json:"downloadURL"`
	ReleaseURL  string `json:"releaseURL"`
}

type release struct {
	Tag        string `json:"tag_name"`
	Draft      *bool  `json:"draft"`
	Prerelease *bool  `json:"prerelease"`
	Assets     []struct {
		Name  string `json:"name"`
		State string `json:"state"`
		URL   string `json:"browser_download_url"`
	} `json:"assets"`
}

var (
	releaseClient = newReleaseClient()
	stableVersion = regexp.MustCompile(`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
)

func newReleaseClient() *http.Client {
	return &http.Client{
		// Keep release checks independent of OS and environment proxy settings.
		Transport: &http.Transport{
			ForceAttemptHTTP2:      true,
			IdleConnTimeout:        30 * time.Second,
			MaxResponseHeaderBytes: 64 << 10,
		},
		Timeout: 5 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

// Check fetches public release metadata and compares versions locally.
func Check(ctx context.Context, current, goos, arch string) (Info, error) {
	return check(ctx, releaseClient, current, goos, arch)
}

func check(ctx context.Context, client *http.Client, current, goos, arch string) (Info, error) {
	current = strings.TrimPrefix(current, "v")
	if !stableVersion.MatchString(current) {
		return Info{}, errors.New("invalid installed version")
	}
	info := Info{Current: current}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, latestReleaseAPI, nil)
	if err != nil {
		return info, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", "Inspiration-Storage")
	response, err := client.Do(request)
	if err != nil {
		return info, fmt.Errorf("fetch latest release: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return info, fmt.Errorf("fetch latest release: GitHub returned HTTP %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, maxReleaseBytes+1))
	if err != nil {
		return info, fmt.Errorf("read latest release: %w", err)
	}
	if len(body) > maxReleaseBytes {
		return info, errors.New("latest release metadata is too large")
	}

	var latest release
	if err := json.Unmarshal(body, &latest); err != nil {
		return info, fmt.Errorf("decode latest release: %w", err)
	}
	if latest.Draft == nil || *latest.Draft || latest.Prerelease == nil || *latest.Prerelease {
		return info, errors.New("latest release is not a published stable release")
	}
	version, prefixed := strings.CutPrefix(latest.Tag, "v")
	if !prefixed || !stableVersion.MatchString(version) {
		return info, errors.New("latest release has an invalid version tag")
	}
	info.Latest = version
	info.ReleaseURL = releasesURL + "/tag/" + latest.Tag
	info.Available = newerVersion(version, current)
	if info.Available {
		info.DownloadURL = latest.installerURL(version, goos, arch)
	}
	return info, nil
}

func newerVersion(latest, current string) bool {
	installedParts := strings.Split(current, ".")
	for i, part := range strings.Split(latest, ".") {
		installed := installedParts[i]
		// Valid components have no leading zeros, so length determines magnitude first.
		if len(part) != len(installed) {
			return len(part) > len(installed)
		}
		if part != installed {
			return part > installed
		}
	}
	return false
}

func (r release) installerURL(version, goos, arch string) string {
	if arch != "amd64" && arch != "arm64" {
		return ""
	}
	var name string
	switch goos {
	case "darwin":
		name = "inspiration-storage-" + version + ".dmg"
	case "windows":
		name = "inspiration-storage-setup-" + version + "-" + arch + ".exe"
	default:
		return ""
	}

	downloadURL := releasesURL + "/download/" + r.Tag + "/" + name
	for _, asset := range r.Assets {
		if asset.Name == name && asset.State == "uploaded" && asset.URL == downloadURL {
			return downloadURL
		}
	}
	return ""
}
