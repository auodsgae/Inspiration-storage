package video

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/auodsgae/Inspiration-storage/internal/library"
)

const youtubeMetadataURL = "https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3DB0J27sf9N1Y"

func thumbnailFixture(t *testing.T) []byte {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

type upstreamStep struct {
	url          string
	referer      string
	status       int
	header       http.Header
	body         string
	streamedBody bool
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func upstream(t *testing.T, steps ...upstreamStep) *http.Client {
	t.Helper()
	var calls int
	t.Cleanup(func() {
		if calls != len(steps) {
			t.Errorf("upstream calls = %d, want %d", calls, len(steps))
		}
	})

	return newClient(roundTripFunc(func(req *http.Request) (*http.Response, error) {
		t.Helper()
		if calls >= len(steps) {
			t.Fatalf("unexpected request to %s", req.URL)
		}
		want := steps[calls]
		calls++
		if got := req.URL.String(); got != want.url {
			t.Fatalf("request %d URL = %s, want %s", calls, got, want.url)
		}
		if req.Method != http.MethodGet || req.Body != nil || req.Host != req.URL.Host {
			t.Fatalf("unexpected method, body, or host on request %d", calls)
		}
		if got := req.Referer(); got != want.referer {
			t.Fatalf("request %d referer = %q, want %q", calls, got, want.referer)
		}
		for key, values := range req.Header {
			if key == "Referer" || key == "User-Agent" && len(values) == 1 && values[0] == "" {
				continue
			}
			t.Fatalf("unexpected request header %q", key)
		}
		if _, ok := req.Context().Deadline(); !ok {
			t.Fatalf("request %d did not have a deadline", calls)
		}

		status := want.status
		if status == 0 {
			status = http.StatusOK
		}
		length := int64(len(want.body))
		if want.streamedBody {
			length = -1
		}
		return &http.Response{
			StatusCode:    status,
			Header:        want.header,
			Body:          io.NopCloser(strings.NewReader(want.body)),
			ContentLength: length,
		}, nil
	}))
}

func assertImportError(t *testing.T, err error, key string, status int) {
	t.Helper()
	var apiErr *library.APIError
	if !errors.As(err, &apiErr) || apiErr.Key != key || apiErr.Status != status || err.Error() != key {
		t.Fatalf("got error %v, want %s (%d)", err, key, status)
	}
}

func TestImportRejectsUnsupportedInputWithoutTraffic(t *testing.T) {
	for _, input := range []string{
		"",
		"https://vimeo.com/12004761",
		"https://localhost/video/BV1NE2DBKER9",
		"https://www.youtube.com.example.com/watch?v=B0J27sf9N1Y",
		"https://www.youtube.com@localhost/watch?v=B0J27sf9N1Y",
		"https://user:private@www.youtube.com/watch?v=B0J27sf9N1Y",
		"https://www.youtube.com:8443/watch?v=B0J27sf9N1Y",
		"file:///Users/me/private",
		"https://b23.tv/%2Fanything",
		"https://b23.tv/one/two",
		"https://b23.tv/" + strings.Repeat("a", 2048),
		"https://youtu.be/B0J27sf9N1Y%2f",
		"https://www.youtube.com/watch?v=file%3A%2F%2F%2FUsers%2Fme",
	} {
		t.Run(input, func(t *testing.T) {
			_, err := importVideo(context.Background(), input, upstream(t))
			assertImportError(t, err, "unsupportedVideoUrl", http.StatusBadRequest)
		})
	}
}

func TestYouTubeImportNormalizesInputAndFallsBackToOriginalThumbnail(t *testing.T) {
	png := thumbnailFixture(t)

	client := upstream(t,
		upstreamStep{url: youtubeMetadataURL, body: `{"title":"A tutorial","author_name":"A creator","thumbnail_url":"http://i.ytimg.com/vi/B0J27sf9N1Y/hqdefault.jpg?tracking=owner#local"}`},
		upstreamStep{url: "https://i.ytimg.com/vi/B0J27sf9N1Y/maxresdefault.jpg", status: http.StatusFound, header: http.Header{"Location": {"https://example.com/redirect"}}},
		upstreamStep{url: "https://i.ytimg.com/vi/B0J27sf9N1Y/mqdefault.jpg", header: http.Header{"Content-Type": {"image/jpeg"}}, body: "not an image"},
		upstreamStep{url: "https://i.ytimg.com/vi/B0J27sf9N1Y/hqdefault.jpg", header: http.Header{"Content-Type": {"image/png"}}, body: string(png)},
	)
	got, err := importVideo(context.Background(), "  youtu.be/B0J27sf9N1Y?si=private&t=40#local  ", client)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "A tutorial" || got.Publisher != "A creator" || got.URL != "https://www.youtube.com/watch?v=B0J27sf9N1Y" || got.MIME != "image/png" || !bytes.Equal(got.Data, png) {
		t.Fatalf("unexpected import result: %+v", got)
	}
}

func TestYouTubeLinkForms(t *testing.T) {
	for _, input := range []string{
		"https://www.youtube.com:443/watch?v=B0J27sf9N1Y",
		"http://WWW.YOUTUBE.COM:80/watch?v=B0J27sf9N1Y",
		"https://www.youtube.com/watch/?v=B0J27sf9N1Y",
		"https://m.youtube.com/watch?v=B0J27sf9N1Y&list=tracker",
		"https://music.youtube.com/watch?v=B0J27sf9N1Y",
		"https://www.youtube.com/shorts/B0J27sf9N1Y/",
		"https://www.youtube.com/live/B0J27sf9N1Y",
		"https://www.youtube.com/v/B0J27sf9N1Y",
		"https://www.youtube-nocookie.com/embed/B0J27sf9N1Y",
	} {
		t.Run(input, func(t *testing.T) {
			client := upstream(t, upstreamStep{url: youtubeMetadataURL, status: http.StatusNotFound})
			_, err := importVideo(context.Background(), input, client)
			assertImportError(t, err, "videoUnavailable", http.StatusBadGateway)
		})
	}
}

func TestBilibiliShortImportUsesSanitizedRedirectsAndMetadata(t *testing.T) {
	png := thumbnailFixture(t)
	client := upstream(t,
		upstreamStep{url: "https://b23.tv/demo", status: http.StatusFound,
			header: http.Header{"Location": {"/follow/?token=second#local"}}, body: "private redirect body"},
		upstreamStep{url: "https://b23.tv/follow", status: http.StatusTemporaryRedirect,
			header: http.Header{"Location": {"http://m.bilibili.com/video/BV1NE2DBKER9/?share_source=copy_web&token=third"}}},
		upstreamStep{url: "https://api.bilibili.com/x/web-interface/view?bvid=BV1NE2DBKER9", referer: "https://www.bilibili.com/",
			body: `{"code":0,"data":{"bvid":"BV1NE2DBKER9","title":"甜甜圈課程","owner":{"name":"甜甜圈仙人"},"pic":"//i1.hdslb.com/bfs/archive/thumb.png?private=fourth"}}`},
		upstreamStep{url: "https://i1.hdslb.com/bfs/archive/thumb.png", header: http.Header{"Content-Type": {"image/png"}}, body: string(png)},
	)
	got, err := importVideo(context.Background(), "http://b23.tv/demo/?token=first#local", client)
	if err != nil {
		t.Fatal(err)
	}
	if got.Name != "甜甜圈課程" || got.Publisher != "甜甜圈仙人" || got.URL != "https://www.bilibili.com/video/BV1NE2DBKER9/" || got.MIME != "image/png" || !bytes.Equal(got.Data, png) {
		t.Fatalf("unexpected import result: %+v", got)
	}
}

func TestBilibiliLegacyLinkUsesNumericID(t *testing.T) {
	client := upstream(t, upstreamStep{
		url: "https://api.bilibili.com/x/web-interface/view?aid=1234", referer: "https://www.bilibili.com/",
		status: http.StatusNotFound,
	})
	_, err := importVideo(context.Background(), "https://www.bilibili.com/video/AV001234/?campaign=secret", client)
	assertImportError(t, err, "videoUnavailable", http.StatusBadGateway)
}

func TestBilibiliShortRejectsUnapprovedRedirects(t *testing.T) {
	for _, location := range []string{
		"https://example.com/video/BV1NE2DBKER9/",
		"https://www.youtube.com/watch?v=B0J27sf9N1Y",
		"https://b23.tv.example.com/demo",
		"https://b23.tv/other/login",
		"https://b23.tv:8443/follow",
		"https://private@b23.tv/follow",
		"https://api.bilibili.com/x/web-interface/view?bvid=BV1NE2DBKER9",
	} {
		t.Run(location, func(t *testing.T) {
			client := upstream(t, upstreamStep{url: "https://b23.tv/demo", status: http.StatusFound, header: http.Header{"Location": {location}}})
			_, err := importVideo(context.Background(), "https://b23.tv/demo?tracking=owner", client)
			assertImportError(t, err, "videoUnavailable", http.StatusBadGateway)
		})
	}
}

func TestBilibiliShortBoundsRedirectHops(t *testing.T) {
	client := upstream(t,
		upstreamStep{url: "https://b23.tv/demo", status: http.StatusFound, header: http.Header{"Location": {"/one?tracking=owner"}}},
		upstreamStep{url: "https://b23.tv/one", status: http.StatusFound, header: http.Header{"Location": {"/two?tracking=owner"}}},
		upstreamStep{url: "https://b23.tv/two", status: http.StatusFound, header: http.Header{"Location": {"/three?tracking=owner"}}},
	)
	_, err := importVideo(context.Background(), "https://b23.tv/demo", client)
	assertImportError(t, err, "videoUnavailable", http.StatusBadGateway)
}

func TestYouTubeRejectsUnapprovedThumbnailLocations(t *testing.T) {
	for _, location := range []string{
		"https://example.com/vi/B0J27sf9N1Y/hqdefault.jpg",
		"https://i.ytimg.com.example.com/vi/B0J27sf9N1Y/hqdefault.jpg",
		"https://i.ytimg.com/vi/Wx84FdVvU2A/hqdefault.jpg",
		"https://i.ytimg.com/vi/B0J27sf9N1Y/../../other.jpg",
		"https://i.ytimg.com/vi/B0J27sf9N1Y/%68qdefault.jpg",
		"https://user:private@i.ytimg.com/vi/B0J27sf9N1Y/hqdefault.jpg",
		"https://i.ytimg.com:8443/vi/B0J27sf9N1Y/hqdefault.jpg",
	} {
		t.Run(location, func(t *testing.T) {
			client := upstream(t, upstreamStep{
				url: youtubeMetadataURL, body: `{"title":"Video","thumbnail_url":"` + location + `"}`,
			})
			_, err := importVideo(context.Background(), "https://youtu.be/B0J27sf9N1Y", client)
			assertImportError(t, err, "thumbnailUnavailable", http.StatusBadGateway)
		})
	}
}

func TestMetadataIsBoundedAndDoesNotFollowRedirects(t *testing.T) {
	oversized := `{"title":"` + strings.Repeat("A", 1024*1024) + `","thumbnail_url":"https://i.ytimg.com/vi/B0J27sf9N1Y/hqdefault.jpg"}`
	for name, step := range map[string]upstreamStep{
		"redirect":         {url: youtubeMetadataURL, status: http.StatusFound, header: http.Header{"Location": {"https://example.com/redirect"}}},
		"too large":        {url: youtubeMetadataURL, body: oversized},
		"stream too large": {url: youtubeMetadataURL, body: oversized, streamedBody: true},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := importVideo(context.Background(), "https://youtu.be/B0J27sf9N1Y", upstream(t, step))
			assertImportError(t, err, "videoUnavailable", http.StatusBadGateway)
		})
	}
}

func TestCanceledImportMakesNoRequests(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := importVideo(ctx, "https://youtu.be/B0J27sf9N1Y", upstream(t))
	assertImportError(t, err, "videoUnavailable", http.StatusBadGateway)
}

func TestProviderTransportDisablesAmbientProxy(t *testing.T) {
	transport := providerClient.Transport.(*http.Transport)
	if transport.Proxy != nil {
		t.Fatal("provider transport can send requests through an ambient proxy")
	}
}
