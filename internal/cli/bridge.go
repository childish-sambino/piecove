package cli

import (
	"flag"
	"fmt"

	"github.com/childish-sambino/piecove/internal/bridge"
	"github.com/childish-sambino/piecove/internal/config"
)

// Bridge runs the host side of the container↔host handoff: open pending
// OAuth URLs, and with --watch also keep playing voice notifications.
func Bridge(args []string) error {
	fs := flag.NewFlagSet("bridge", flag.ContinueOnError)
	watch := fs.Bool("watch", false, "keep watching: open auth URLs and play voice notifications")
	if err := fs.Parse(args); err != nil {
		return err
	}
	authDir, err := config.AuthDir()
	if err != nil {
		return err
	}
	if *watch {
		return bridge.Watch(authDir)
	}
	opened, err := bridge.OpenURL(authDir)
	if err != nil {
		return err
	}
	if !opened {
		return fmt.Errorf("no auth URL waiting in %s (use --watch to also play voice notifications)", authDir)
	}
	return nil
}
