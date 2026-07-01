// Package bridge is the host side of the container↔host handoff. The
// container has no browser or speakers, so OAuth URLs and TTS utterances are
// dropped into the auth dir by in-container shims; this opens the URLs in the
// real browser and speaks the utterances — `say` on macOS, espeak-ng/spd-say
// on Linux, printed when no TTS engine exists.
package bridge

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// OpenURL opens the pending OAuth URL, if any. Returns whether one was opened.
func OpenURL(authDir string) (bool, error) {
	p := filepath.Join(authDir, "latest-url.txt")
	b, err := os.ReadFile(p)
	if err != nil || len(strings.TrimSpace(string(b))) == 0 {
		return false, nil
	}
	url := strings.TrimSpace(string(b))
	if err := browse(url); err != nil {
		return false, fmt.Errorf("could not open %s: %w", url, err)
	}
	_ = os.Remove(p)
	fmt.Println("Opened:", url)
	return true, nil
}

func browse(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Run()
	default:
		if _, err := exec.LookPath("xdg-open"); err == nil {
			return exec.Command("xdg-open", url).Run()
		}
		fmt.Println("Open in your browser:", url)
		return nil
	}
}

// SayPending plays queued utterances in order. Each file is voice on line 1
// (may be empty), text on the rest.
func SayPending(authDir string) {
	sayDir := filepath.Join(authDir, "say")
	entries, err := os.ReadDir(sayDir)
	if err != nil {
		return
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names) // timestamped names → playback order
	for _, name := range names {
		p := filepath.Join(sayDir, name)
		b, err := os.ReadFile(p)
		_ = os.Remove(p)
		if err != nil {
			continue
		}
		voice, text, _ := strings.Cut(string(b), "\n")
		text = strings.TrimSpace(text)
		if text == "" {
			continue
		}
		speak(strings.TrimSpace(voice), text)
	}
}

func speak(voice, text string) {
	switch runtime.GOOS {
	case "darwin":
		args := []string{}
		if voice != "" {
			args = append(args, "-v", voice)
		}
		_ = exec.Command("say", append(args, text)...).Run()
	default:
		for _, tts := range []string{"espeak-ng", "espeak", "spd-say"} {
			if _, err := exec.LookPath(tts); err == nil {
				_ = exec.Command(tts, text).Run()
				return
			}
		}
		fmt.Println("🔊", text)
	}
}

// Watch polls the auth dir, opening URLs and speaking notifications until
// interrupted. Any backlog of stale utterances is dropped first so starting
// the watcher doesn't replay old notifications.
func Watch(authDir string) error {
	_ = os.MkdirAll(filepath.Join(authDir, "say"), 0o755)
	drainSay(authDir)
	fmt.Println("Watching for auth URLs and voice notifications… (Ctrl-C to stop)")
	for {
		if _, err := OpenURL(authDir); err != nil {
			fmt.Fprintln(os.Stderr, err)
		}
		SayPending(authDir)
		time.Sleep(time.Second)
	}
}

func drainSay(authDir string) {
	entries, err := os.ReadDir(filepath.Join(authDir, "say"))
	if err != nil {
		return
	}
	for _, e := range entries {
		_ = os.Remove(filepath.Join(authDir, "say", e.Name()))
	}
}
