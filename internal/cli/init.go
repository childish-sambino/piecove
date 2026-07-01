package cli

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/childish-sambino/piecove/internal/config"
	"github.com/childish-sambino/piecove/internal/runtime"
)

// Init writes the config.env template into the state dir. Refuses to
// overwrite an existing config unless --force.
func Init(args []string) error {
	fs := flag.NewFlagSet("init", flag.ContinueOnError)
	force := fs.Bool("force", false, "overwrite an existing config.env")
	if err := fs.Parse(args); err != nil {
		return err
	}

	p, err := config.Path()
	if err != nil {
		return err
	}
	if _, err := os.Stat(p); err == nil && !*force {
		fmt.Printf("config already exists at %s (use --force to overwrite)\n", p)
		return nil
	}
	example, err := runtime.ConfigExample()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	// 0600: this file will hold API keys.
	if err := os.WriteFile(p, example, 0o600); err != nil {
		return err
	}
	fmt.Printf("Wrote %s\n\nNext:\n  1. Edit it — set PROVIDER, MODEL, PIECOVE_API_KEY\n  2. piecove run ~/code/your-repo\n", p)
	return nil
}
