package cli

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/childish-sambino/piecove/internal/config"
	"github.com/childish-sambino/piecove/internal/detect"
	"github.com/childish-sambino/piecove/internal/dockerx"
	"github.com/childish-sambino/piecove/internal/runtime"
	"github.com/childish-sambino/piecove/internal/stage"
)

const maxSlots = 10

type runOpts struct {
	workspace string
	db        string // auto | on | off
	serve     string // auto | on | off
	slot      int    // -1 = auto
	wait      bool
	cmd       []string
}

func parseRunArgs(args []string) (runOpts, error) {
	o := runOpts{db: "auto", serve: "auto", slot: -1, wait: true}
	i := 0
	for ; i < len(args); i++ {
		a := args[i]
		switch {
		case a == "--":
			o.cmd = args[i+1:]
			i = len(args)
		case a == "--db":
			o.db = "on"
		case a == "--no-db":
			o.db = "off"
		case a == "--serve":
			o.serve = "on"
		case a == "--no-serve":
			o.serve = "off"
		case a == "--no-wait":
			o.wait = false
		case a == "--slot" && i+1 < len(args):
			n, err := strconv.Atoi(args[i+1])
			if err != nil || n < 0 || n >= maxSlots {
				return o, fmt.Errorf("--slot must be 0..%d", maxSlots-1)
			}
			o.slot = n
			i++
		case strings.HasPrefix(a, "--slot="):
			n, err := strconv.Atoi(strings.TrimPrefix(a, "--slot="))
			if err != nil || n < 0 || n >= maxSlots {
				return o, fmt.Errorf("--slot must be 0..%d", maxSlots-1)
			}
			o.slot = n
		case strings.HasPrefix(a, "--"):
			return o, fmt.Errorf("unknown flag %q (see `piecove help`)", a)
		default:
			// First bare arg that is a directory = the workspace; everything
			// after that is the command to run instead of a shell.
			if o.workspace == "" && isDir(a) {
				abs, err := filepath.Abs(a)
				if err != nil {
					return o, err
				}
				o.workspace = abs
			} else {
				o.cmd = args[i:]
				i = len(args)
			}
		}
	}
	if o.workspace == "" {
		wd, err := os.Getwd()
		if err != nil {
			return o, err
		}
		o.workspace = wd
	}
	return o, nil
}

func isDir(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

// Run launches the container against a working dir: detect what the repo
// needs, stage the user's Claude config, materialize the runtime, and hand
// off to docker compose.
func Run(args []string) error {
	o, err := parseRunArgs(args)
	if err != nil {
		return err
	}

	cfg, err := config.Load()
	if err != nil {
		return err
	}

	// ── detection ──────────────────────────────────────────────────────────
	extra := []string{"WORKSPACE_DIR=" + o.workspace}
	// config.env values feed compose interpolation (PGUSER, REDIS_PORT, …);
	// the env_file in the compose file delivers them into the container.
	for k, v := range cfg {
		extra = append(extra, k+"="+v)
	}

	if rv := detect.RubyVersion(o.workspace); rv != "" {
		fmt.Println("piecove: detected Ruby", rv)
		extra = append(extra, "RUBY_VERSION="+rv)
	}

	wantDB := o.db == "on"
	if o.db == "auto" && detect.NeedsPostgres(o.workspace) {
		wantDB = true
		fmt.Println("piecove: Postgres app detected → starting db (use --no-db to skip)")
	}

	wantServe := o.serve == "on"
	if o.serve == "auto" && detect.IsRails(o.workspace) {
		wantServe = true
		fmt.Println("piecove: Rails app detected → auto-serving its dev stack (use --no-serve to skip)")
	}
	wantRedis := wantServe && detect.NeedsRedis(o.workspace)

	slot := 0
	if wantServe {
		if o.slot >= 0 {
			slot = o.slot
		} else {
			slot = detect.FreeSlot(maxSlots)
		}
		if slot > 0 {
			fmt.Printf("piecove: slot %d → app on http://localhost:%d, isolated db + sidekiq queues\n", slot, 3000+slot)
		}
	}

	serveFlag := "0"
	if wantServe {
		serveFlag = "1"
	}
	waitFlag := "1"
	if !o.wait {
		waitFlag = "0"
	}
	extra = append(extra,
		"PIECOVE_SERVE="+serveFlag,
		"PIECOVE_SLOT="+strconv.Itoa(slot),
		"PIECOVE_APP="+detect.AppName(filepath.Base(o.workspace)),
		"PIECOVE_WAIT="+waitFlag,
		"GIT_USER_NAME="+gitGlobal("user.name"),
		"GIT_USER_EMAIL="+gitGlobal("user.email"),
	)

	// ── stage + materialize ────────────────────────────────────────────────
	stageDir, err := config.StageDir()
	if err != nil {
		return err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return err
	}
	if err := stage.Claude(filepath.Join(home, ".claude"), stageDir); err != nil {
		return fmt.Errorf("staging ~/.claude: %w", err)
	}
	if _, err := config.AuthDir(); err != nil {
		return err
	}
	runtimeDir, err := config.RuntimeDir()
	if err != nil {
		return err
	}
	if err := runtime.Materialize(runtimeDir); err != nil {
		return fmt.Errorf("materializing runtime: %w", err)
	}

	// ── docker ─────────────────────────────────────────────────────────────
	client, err := dockerx.New(filepath.Join(runtimeDir, "docker-compose.yml"))
	if err != nil {
		return err
	}
	if err := client.EnsureVolume("piecove-home"); err != nil {
		return err
	}
	if err := client.Compose(extra, "build"); err != nil {
		return fmt.Errorf("image build failed: %w", err)
	}
	if wantDB {
		fmt.Println("piecove: starting Postgres…")
		if err := client.Compose(extra, "--profile", "db", "up", "-d", "db"); err != nil {
			return err
		}
	}
	if wantRedis {
		fmt.Println("piecove: starting Redis (app uses sidekiq/redis)…")
		if err := client.Compose(extra, "--profile", "redis", "up", "-d", "redis"); err != nil {
			return err
		}
	}

	fmt.Println("piecove: working on", o.workspace)
	composeArgs := append([]string{"run", "--rm", "piecove"}, o.cmd...)
	return client.Compose(extra, composeArgs...)
}

func gitGlobal(key string) string {
	out, err := exec.Command("git", "config", "--global", key).Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}
