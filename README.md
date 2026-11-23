# Inspiration Storage

Inspiration Storage is a desktop reference library for screenshots, website layouts and video thumbnails. Use tags and smart collections to find images, compare layouts side by side, or arrange them on a whiteboard. The app starts with an empty library.

## Install

Download the installer for your platform from [GitHub Releases](https://github.com/auodsgae/Inspiration-storage/releases).

- **macOS** — Open the universal disk image and drag Inspiration Storage into Applications. It supports Apple Silicon and Intel Macs. The disk image contains an ad-hoc-signed app. It has no Apple notarization.
- **Windows** — Run the x64 or ARM64 setup executable for your machine. The app uses the Microsoft Edge WebView2 Runtime. The installer has no Authenticode signature.

## Local data and network use

The app keeps imported files, labels and whiteboards on the computer. On macOS the library is under `~/Library/Application Support/com.auodsgae.inspiration-storage`. On Windows it is under `%LOCALAPPDATA%\com.auodsgae.inspiration-storage`.

The interface and library communicate through the MyGo webview protocol. The app has no HTTP listener, account, cloud sync, analytics or automatic update service. Opening a library, importing a file or screenshot, and editing tags and whiteboards work offline.

Importing an uncached video link makes HTTPS requests to YouTube or Bilibili and their thumbnail hosts. The provider receives the video identifier or short-link code and the usual connection information, including the public IP address. The importer drops share tracking parameters and sends no cookies, library files, labels or whiteboard contents. Selecting an original source link opens it in the system browser.

## Develop

Use Go 1.27.4 and the MyGo version pinned in `go.mod`. Node.js 24 or later is useful for running the frontend model tests. The installed app runs without Node.js.

```sh
go test ./...
npm test
go run .
```

To build the installers on macOS with NSIS available on your path:

```sh
go tool mygo build -platform darwin/universal,windows/amd64,windows/arm64
```

The packaged frontend is embedded from an explicit list of app files. Use a separate data directory for tests with sample data and keep personal libraries out of Git.
