package main

import (
	"embed"
	"errors"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"

	"github.com/auodsgae/Inspiration-storage/internal/library"
	"github.com/auodsgae/Inspiration-storage/internal/video"
	"github.com/egoist/mygo"
)

const appName = "Inspiration Storage"
const dataFolder = "inspiration-storage"
const legacyDataFolder = "com.auodsgae.inspiration-storage"

//go:embed public/index.html public/app.js public/library.js public/locale.js public/style.css public/board.js public/board.css
var frontend embed.FS

func main() {
	if err := runDesktop(); err != nil {
		// Avoid printing paths or data from a failed library open to OS logs.
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}

func runDesktop() error {
	mygo.App.SetName(appName)
	if !mygo.App.RequestSingleInstanceLock() {
		return nil
	}

	dataDir, err := libraryDir()
	if err != nil {
		return errors.New("Inspiration Storage could not locate its local data folder.")
	}
	web, err := fs.Sub(frontend, "public")
	if err != nil {
		return errors.New("Inspiration Storage could not open its bundled interface.")
	}
	handler, err := library.New(dataDir, web, video.Import)
	if err != nil {
		return errors.New("Inspiration Storage could not open its local library.")
	}
	var trustedPage atomic.Pointer[mygo.Page]
	if err := mygo.Protocol.Handle("mygo", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page := trustedPage.Load()
		if page == nil || page != mygo.CallerPage(r.Context()) {
			http.NotFound(w, r)
			return
		}
		handler.ServeHTTP(w, r)
	})); err != nil {
		return errors.New("Inspiration Storage could not register its local interface.")
	}

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title: appName, Width: 1220, Height: 820, MinWidth: 480, MinHeight: 500,
			Page: mygo.PageOptions{
				DevTools:  mygo.DevToolsDisabled,
				Session:   mygo.NewEphemeralSession(),
				Untrusted: true,
			},
		})
		page := win.Page()
		trustedPage.Store(page)
		page.OnWillNavigate(func(event *mygo.NavigateEvent) {
			if isFrontendURL(event.URL) {
				return
			}
			event.PreventDefault()
			openWebsite(event.URL, event.UserInitiated)
		})
		page.SetWindowOpenHandler(func(request mygo.WindowOpenRequest) *mygo.WindowOptions {
			openWebsite(request.URL, request.UserInitiated)
			return nil
		})
		win.OnClosed(func() {
			trustedPage.Store(nil)
			mygo.App.Quit()
		})
		page.LoadURL("/")
	})
	if err := mygo.App.Run(); err != nil {
		return errors.New("Inspiration Storage could not start its desktop window.")
	}
	return nil
}

func libraryDir() (string, error) {
	if runtime.GOOS == "windows" {
		if local := os.Getenv("LOCALAPPDATA"); filepath.IsAbs(local) {
			return libraryDirIn(local)
		}
	}
	root, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return libraryDirIn(root)
}

func libraryDirIn(root string) (string, error) {
	path := filepath.Join(root, dataFolder)
	if _, err := os.Lstat(path); err == nil {
		return path, nil
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}

	old := filepath.Join(root, legacyDataFolder)
	info, err := os.Lstat(old)
	if errors.Is(err, fs.ErrNotExist) {
		return path, nil
	}
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fs.ErrInvalid
	}
	if err := os.Rename(old, path); err != nil {
		return "", err
	}
	return path, nil
}

func isFrontendURL(value string) bool {
	u, err := url.Parse(value)
	if err != nil || u.User != nil {
		return false
	}
	return (u.Scheme == "mygo" && u.Host == "localhost") ||
		(u.Scheme == "http" && u.Host == "mygo.localhost")
}

func openWebsite(value string, userInitiated bool) {
	if !userInitiated || isFrontendURL(value) {
		return
	}
	u, err := url.Parse(value)
	if err == nil && (u.Scheme == "https" || u.Scheme == "http") && u.Hostname() != "" && u.User == nil {
		go mygo.Shell.OpenExternal(u.String())
	}
}
