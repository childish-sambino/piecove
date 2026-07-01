// Package config owns piecove's state directory (~/.piecove) and the
// config.env file inside it. Secrets and provider choice live in config.env
// (never in the repo being worked on); everything else in the state dir is
// derived and disposable.
package config

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Dir returns the piecove state directory: $PIECOVE_HOME or ~/.piecove.
func Dir() (string, error) {
	if d := os.Getenv("PIECOVE_HOME"); d != "" {
		return d, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve home dir: %w", err)
	}
	return filepath.Join(home, ".piecove"), nil
}

func subdir(name string) (string, error) {
	d, err := Dir()
	if err != nil {
		return "", err
	}
	p := filepath.Join(d, name)
	if err := os.MkdirAll(p, 0o755); err != nil {
		return "", err
	}
	return p, nil
}

// RuntimeDir holds the materialized container assets (Dockerfile, compose
// file, entrypoint, extensions) — refreshed from the embedded copies each run.
func RuntimeDir() (string, error) { return subdir("runtime") }

// StageDir holds the user's ~/.claude bits staged for read-only mounting.
func StageDir() (string, error) { return subdir("stage") }

// AuthDir is the container↔host handoff for OAuth URLs and TTS utterances.
func AuthDir() (string, error) { return subdir("auth") }

// Path returns the config.env location.
func Path() (string, error) {
	if p := os.Getenv("PIECOVE_CONFIG"); p != "" {
		return p, nil
	}
	d, err := Dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.env"), nil
}

// Load parses config.env into a map. Lines are KEY=VALUE; blank lines and
// #-comments are ignored; surrounding single/double quotes on values are
// stripped. Returns a helpful error when the file doesn't exist yet.
func Load() (map[string]string, error) {
	p, err := Path()
	if err != nil {
		return nil, err
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("no config at %s — run `piecove init`, then set PROVIDER/MODEL/PIECOVE_API_KEY", p)
		}
		return nil, err
	}
	defer f.Close()
	return Parse(f)
}

// Parse reads env-file syntax from r. Exported for tests.
func Parse(r interface{ Read([]byte) (int, error) }) (map[string]string, error) {
	out := map[string]string{}
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
			v = v[1 : len(v)-1]
		}
		if k != "" {
			out[k] = v
		}
	}
	return out, sc.Err()
}
