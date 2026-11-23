// Package video imports metadata and cover images from supported video providers.
package video

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/auodsgae/Inspiration-storage/internal/library"
)

const (
	providerTimeout = 10 * time.Second
	metadataLimit   = 1 << 20
	imageLimit      = 20 << 20
)

var (
	errUpstream    = errors.New("invalid upstream response")
	providerClient = newClient(privateTransport())
)

// Import gets video metadata and a raster thumbnail using only provider endpoints.
func Import(ctx context.Context, value string) (library.ImportedVideo, error) {
	return importVideo(ctx, value, providerClient)
}

func privateTransport() *http.Transport {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.DisableCompression = true
	transport.MaxResponseHeaderBytes = 64 << 10
	return transport
}

func newClient(transport http.RoundTripper) *http.Client {
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func importVideo(ctx context.Context, value string, client *http.Client) (library.ImportedVideo, error) {
	input := parseInput(value)
	video, short := videoFromURL(input), shortCode(input)
	if video.provider == "" && short == "" {
		return library.ImportedVideo{}, &library.APIError{Key: "unsupportedVideoUrl", Status: http.StatusBadRequest}
	}

	metadataCtx, cancelMetadata := context.WithTimeout(ctx, providerTimeout)
	defer cancelMetadata()
	if short != "" {
		video = resolveBilibiliShort(metadataCtx, client, short)
		if video.provider == "" {
			return library.ImportedVideo{}, &library.APIError{Key: "videoUnavailable", Status: http.StatusBadGateway}
		}
	}
	metadata, err := getMetadata(metadataCtx, client, video)
	cancelMetadata()
	if err != nil || strings.TrimSpace(metadata.name) == "" {
		return library.ImportedVideo{}, &library.APIError{Key: "videoUnavailable", Status: http.StatusBadGateway}
	}

	thumbnailCtx, cancelThumbnail := context.WithTimeout(ctx, providerTimeout)
	defer cancelThumbnail()
	data, mime, err := getThumbnail(thumbnailCtx, client, video, metadata.thumbnail)
	if err != nil {
		return library.ImportedVideo{}, &library.APIError{Key: "thumbnailUnavailable", Status: http.StatusBadGateway}
	}
	return library.ImportedVideo{
		Name: metadata.name, Publisher: metadata.publisher, URL: metadata.url,
		MIME: mime, Data: data,
	}, nil
}

func request(ctx context.Context, client *http.Client, target *url.URL, referer string) (*http.Response, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "") // Suppress the HTTP client's default User-Agent.
	if referer != "" {
		req.Header.Set("Referer", referer)
	}
	return client.Do(req)
}

func resolveBilibiliShort(ctx context.Context, client *http.Client, code string) videoRef {
	for hop := 0; hop < 3 && code != ""; hop++ {
		target := providerURL("b23.tv", "/"+code, nil)
		resp, err := request(ctx, client, target, "")
		if err != nil {
			break
		}
		resp.Body.Close()
		switch resp.StatusCode {
		case http.StatusMovedPermanently, http.StatusFound, http.StatusSeeOther,
			http.StatusTemporaryRedirect, http.StatusPermanentRedirect:
		default:
			return videoRef{}
		}

		location := resp.Header.Get("Location")
		if location == "" {
			break
		}
		next, err := target.Parse(location)
		if err != nil || !validProviderURL(next) {
			break
		}
		if video := videoFromURL(next); video.provider == bilibili {
			return video
		}
		code = shortCode(next)
	}
	return videoRef{}
}

func responseBytes(ctx context.Context, client *http.Client, target *url.URL, referer string, limit int64) ([]byte, string, error) {
	resp, err := request(ctx, client, target, referer)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || resp.ContentLength > limit {
		return nil, "", errUpstream
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, "", err
	}
	if int64(len(data)) > limit {
		return nil, "", errUpstream
	}
	return data, resp.Header.Get("Content-Type"), nil
}

type videoMetadata struct {
	name      string
	publisher string
	url       string
	thumbnail string
}

func jsonString(value any) string {
	result, _ := value.(string)
	return result
}

func getMetadata(ctx context.Context, client *http.Client, video videoRef) (videoMetadata, error) {
	if video.provider == youtube {
		watch := providerURL("www.youtube.com", "/watch", url.Values{"v": {video.id}}).String()
		target := providerURL("www.youtube.com", "/oembed", url.Values{"url": {watch}, "format": {"json"}})
		response, _, err := responseBytes(ctx, client, target, "", metadataLimit)
		if err != nil {
			return videoMetadata{}, err
		}
		var details struct {
			Title     any `json:"title"`
			Author    any `json:"author_name"`
			Thumbnail any `json:"thumbnail_url"`
		}
		if json.Unmarshal(response, &details) != nil {
			return videoMetadata{}, errUpstream
		}
		return videoMetadata{jsonString(details.Title), jsonString(details.Author), watch, jsonString(details.Thumbnail)}, nil
	}

	query := url.Values{"bvid": {video.id}}
	if video.aid != "" {
		query = url.Values{"aid": {video.aid}}
	}
	target := providerURL("api.bilibili.com", "/x/web-interface/view", query)
	response, _, err := responseBytes(ctx, client, target, "https://www.bilibili.com/", metadataLimit)
	if err != nil {
		return videoMetadata{}, err
	}
	var details struct {
		Code *int `json:"code"`
		Data struct {
			ID        string `json:"bvid"`
			Title     any    `json:"title"`
			Thumbnail any    `json:"pic"`
			Owner     struct {
				Name any `json:"name"`
			} `json:"owner"`
		} `json:"data"`
	}
	if json.Unmarshal(response, &details) != nil || details.Code == nil || *details.Code != 0 ||
		!bilibiliID.MatchString(details.Data.ID) || (video.id != "" && details.Data.ID != video.id) {
		return videoMetadata{}, errUpstream
	}
	watch := providerURL("www.bilibili.com", "/video/"+details.Data.ID+"/", nil).String()
	return videoMetadata{jsonString(details.Data.Title), jsonString(details.Data.Owner.Name), watch, jsonString(details.Data.Thumbnail)}, nil
}

func getThumbnail(ctx context.Context, client *http.Client, video videoRef, value string) ([]byte, string, error) {
	original := thumbnailURL(video, value)
	if original == nil {
		return nil, "", errUpstream
	}

	var candidates []*url.URL
	if video.provider == youtube && strings.HasSuffix(original.Path, "/hqdefault.jpg") {
		for _, size := range []string{"maxresdefault", "mqdefault"} {
			candidates = append(candidates, providerURL(original.Host, "/vi/"+video.id+"/"+size+".jpg", nil))
		}
	}
	for _, candidate := range append(candidates, original) {
		data, mime, err := responseBytes(ctx, client, candidate, "", imageLimit)
		if err == nil {
			if _, ok := library.RasterExtension(data, mime); ok {
				return data, mime, nil
			}
		}
	}
	return nil, "", errUpstream
}
