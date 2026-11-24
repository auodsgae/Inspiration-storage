package main

import (
	"context"
	"errors"
	"net/http"
	"runtime"
	"time"

	"github.com/auodsgae/Inspiration-storage/internal/library"
	"github.com/auodsgae/Inspiration-storage/internal/updates"
	"github.com/egoist/mygo"
)

func checkSignedUpdate(ctx context.Context) (*mygo.Update, error) {
	ctx, cancel := context.WithTimeout(ctx, 12*time.Second)
	defer cancel()
	return mygo.Updater.Check(ctx)
}

func desktopUpdates(current string) library.UpdateEndpoint {
	return library.UpdateEndpoint{
		Version: current,
		Check: func(ctx context.Context) (any, error) {
			update, err := checkSignedUpdate(ctx)
			if err != nil {
				return updates.Check(ctx, current, runtime.GOOS, runtime.GOARCH)
			}
			info := updates.Info{Current: current, Latest: current}
			if update != nil {
				info.Latest, info.Available, info.InApp = update.Version, true, true
			}
			return info, nil
		},
		Install: func(ctx context.Context, version string) error {
			update, err := checkSignedUpdate(ctx)
			if errors.Is(err, mygo.ErrUpdatesDisabled) {
				return &library.APIError{Key: "updateInstallUnavailable", Status: http.StatusConflict}
			}
			if err != nil {
				return err
			}
			if update == nil || update.Version != version {
				return &library.APIError{Key: "updateChanged", Status: http.StatusConflict}
			}
			ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
			defer cancel()
			if err := update.Install(ctx, nil); err != nil {
				return err
			}
			mygo.App.Relaunch()
			return nil
		},
	}
}
