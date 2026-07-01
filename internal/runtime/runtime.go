// Package runtime embeds the container definition (compose file, Dockerfile,
// entrypoint, serve script, shims, Pi extensions, bench suite) and
// materializes it into the state dir. Embedding makes the binary
// self-contained: `go install` is a complete install, no clone required.
package runtime

import (
	"embed"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

//go:embed all:assets
var assets embed.FS

// Materialize writes the embedded runtime into dir, overwriting what's there
// so the runtime always matches the binary's version. Shell scripts get +x.
func Materialize(dir string) error {
	return fs.WalkDir(assets, "assets", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel := strings.TrimPrefix(path, "assets")
		rel = strings.TrimPrefix(rel, "/")
		target := filepath.Join(dir, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		b, err := assets.ReadFile(path)
		if err != nil {
			return err
		}
		mode := os.FileMode(0o644)
		if strings.HasSuffix(rel, ".sh") || strings.HasSuffix(rel, ".mjs") {
			mode = 0o755
		}
		if err := os.WriteFile(target, b, mode); err != nil {
			return err
		}
		// WriteFile's mode only applies on creation; enforce it on re-runs too.
		return os.Chmod(target, mode)
	})
}

// ConfigExample returns the embedded config.env template for `piecove init`.
func ConfigExample() ([]byte, error) {
	return assets.ReadFile("assets/config.env.example")
}
