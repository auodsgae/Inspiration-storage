package video

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

const (
	youtube          = "youtube"
	bilibili         = "bilibili"
	youtubeIDPattern = `[a-zA-Z0-9_-]{11}`
)

var (
	inputScheme      = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*:`)
	youtubeID        = regexp.MustCompile(`^` + youtubeIDPattern + `$`)
	youtubeSharePath = regexp.MustCompile(`^/(` + youtubeIDPattern + `)/?$`)
	youtubeVideoPath = regexp.MustCompile(`^/(?:shorts|live|embed|v)/(` + youtubeIDPattern + `)/?$`)
	bilibiliID       = regexp.MustCompile(`^BV[a-zA-Z0-9]{10}$`)
	bilibiliAID      = regexp.MustCompile(`^(?i:av)([0-9]+)$`)
	bilibiliPath     = regexp.MustCompile(`^/video/([a-zA-Z0-9]+)/?$`)
	bilibiliShort    = regexp.MustCompile(`^/([a-zA-Z0-9]{1,32})/?$`)
	thumbnailName    = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}(?:\.[a-zA-Z0-9]{1,8})?$`)
)

type videoRef struct {
	provider string
	id       string
	aid      string
}

func parseInput(value string) *url.URL {
	value = strings.TrimSpace(value)
	if value == "" || len(value) > 2048 {
		return nil
	}
	if !inputScheme.MatchString(value) {
		value = "https://" + value
	}
	parsed, err := url.Parse(value)
	if err != nil || !validProviderURL(parsed) {
		return nil
	}
	return parsed
}

func validProviderURL(u *url.URL) bool {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") ||
		u.Hostname() == "" || u.User != nil || u.EscapedPath() != u.Path {
		return false
	}
	if u.Host == u.Hostname() {
		return true
	}
	// Accept an explicitly written default port. Outbound URLs are rebuilt without it.
	port := strings.TrimLeft(u.Port(), "0")
	return (u.Scheme == "https" && port == "443") || (u.Scheme == "http" && port == "80")
}

func videoFromURL(u *url.URL) videoRef {
	if u == nil {
		return videoRef{}
	}
	switch strings.ToLower(u.Hostname()) {
	case "youtu.be":
		if parts := youtubeSharePath.FindStringSubmatch(u.Path); parts != nil {
			return videoRef{provider: youtube, id: parts[1]}
		}
	case "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com":
		if u.Path == "/watch" || u.Path == "/watch/" {
			if id := u.Query().Get("v"); youtubeID.MatchString(id) {
				return videoRef{provider: youtube, id: id}
			}
		}
		if parts := youtubeVideoPath.FindStringSubmatch(u.Path); parts != nil {
			return videoRef{provider: youtube, id: parts[1]}
		}
	case "bilibili.com", "www.bilibili.com", "m.bilibili.com":
		parts := bilibiliPath.FindStringSubmatch(u.Path)
		if parts == nil {
			break
		}
		if id := parts[1]; bilibiliID.MatchString(id) {
			return videoRef{provider: bilibili, id: id}
		}
		if legacy := bilibiliAID.FindStringSubmatch(parts[1]); legacy != nil {
			if aid, err := strconv.ParseUint(legacy[1], 10, 64); err == nil {
				return videoRef{provider: bilibili, aid: strconv.FormatUint(aid, 10)}
			}
		}
	}
	return videoRef{}
}

func shortCode(u *url.URL) string {
	if u != nil && strings.EqualFold(u.Hostname(), "b23.tv") {
		if parts := bilibiliShort.FindStringSubmatch(u.Path); parts != nil {
			return parts[1]
		}
	}
	return ""
}

func providerURL(host, path string, query url.Values) *url.URL {
	return &url.URL{Scheme: "https", Host: host, Path: path, RawQuery: query.Encode()}
}

func thumbnailURL(video videoRef, value string) *url.URL {
	if strings.HasPrefix(value, "//") {
		value = "https:" + value
	}
	u, err := url.Parse(value)
	if err != nil || !validProviderURL(u) {
		return nil
	}

	host := strings.ToLower(u.Hostname())
	switch video.provider {
	case youtube:
		switch host {
		case "i.ytimg.com", "i1.ytimg.com", "i2.ytimg.com", "i3.ytimg.com", "i4.ytimg.com", "img.youtube.com":
			name, ok := strings.CutPrefix(u.Path, "/vi/"+video.id+"/")
			if !ok {
				name, ok = strings.CutPrefix(u.Path, "/vi_webp/"+video.id+"/")
			}
			if ok && thumbnailName.MatchString(name) {
				return providerURL(host, u.Path, nil)
			}
		}
	case bilibili:
		switch host {
		case "i0.hdslb.com", "i1.hdslb.com", "i2.hdslb.com":
			if name, ok := strings.CutPrefix(u.Path, "/bfs/archive/"); ok && thumbnailName.MatchString(name) {
				return providerURL(host, u.Path, nil)
			}
		}
	}
	return nil
}
