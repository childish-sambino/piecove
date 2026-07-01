// Package stage copies the user's ~/.claude bits (CLAUDE.md, skills,
// settings.json, hooks) into piecove's stage dir for read-only mounting into
// the container. Symlinks are resolved during the copy so dotfiles-repo
// layouts work — the container sees real files, not dangling links.
package stage

import (
	"io"
	"os"
	"path/filepath"
)

// Items staged from ~/.claude when present. hooks/ carries the user's
// notification scripts (e.g. claude-notify.sh) so both agents can speak from
// one source.
var items = []string{"CLAUDE.md", "skills", "settings.json", "hooks"}

// Claude stages the user's claudeDir into stageDir, replacing prior contents.
// Missing items are skipped; nothing here is fatal — an empty stage just means
// the container runs with default agent config.
func Claude(claudeDir, stageDir string) error {
	if err := os.RemoveAll(stageDir); err != nil {
		return err
	}
	if err := os.MkdirAll(stageDir, 0o755); err != nil {
		return err
	}
	for _, item := range items {
		src := filepath.Join(claudeDir, item)
		if _, err := os.Stat(src); err != nil {
			continue // Stat follows symlinks, so a valid link to a dotfiles repo passes
		}
		_ = copyResolved(src, filepath.Join(stageDir, item))
	}
	return nil
}

// copyResolved copies src to dst, following symlinks (files and directories).
func copyResolved(src, dst string) error {
	info, err := os.Stat(src) // follows symlinks
	if err != nil {
		return err
	}
	if info.IsDir() {
		if err := os.MkdirAll(dst, 0o755); err != nil {
			return err
		}
		entries, err := os.ReadDir(src)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := copyResolved(filepath.Join(src, e.Name()), filepath.Join(dst, e.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm()|0o400)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}
