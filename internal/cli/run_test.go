package cli

import (
	"os"
	"testing"
)

func TestParseRunArgs(t *testing.T) {
	dir := t.TempDir()

	t.Run("defaults to cwd", func(t *testing.T) {
		o, err := parseRunArgs(nil)
		if err != nil {
			t.Fatal(err)
		}
		wd, _ := os.Getwd()
		if o.workspace != wd {
			t.Errorf("workspace = %q, want cwd", o.workspace)
		}
		if o.db != "auto" || o.serve != "auto" || o.slot != -1 || !o.wait {
			t.Errorf("defaults wrong: %+v", o)
		}
	})

	t.Run("dir then command", func(t *testing.T) {
		o, err := parseRunArgs([]string{dir, "claude", "--help"})
		if err != nil {
			t.Fatal(err)
		}
		if o.workspace != dir {
			t.Errorf("workspace = %q", o.workspace)
		}
		if len(o.cmd) != 2 || o.cmd[0] != "claude" || o.cmd[1] != "--help" {
			t.Errorf("cmd = %v", o.cmd)
		}
	})

	t.Run("double dash separates command", func(t *testing.T) {
		o, err := parseRunArgs([]string{dir, "--no-db", "--", "pi", "-p", "hello"})
		if err != nil {
			t.Fatal(err)
		}
		if o.db != "off" {
			t.Errorf("db = %q", o.db)
		}
		if len(o.cmd) != 3 || o.cmd[0] != "pi" {
			t.Errorf("cmd = %v", o.cmd)
		}
	})

	t.Run("slot forms", func(t *testing.T) {
		for _, args := range [][]string{{"--slot", "2"}, {"--slot=2"}} {
			o, err := parseRunArgs(args)
			if err != nil {
				t.Fatal(err)
			}
			if o.slot != 2 {
				t.Errorf("%v → slot = %d", args, o.slot)
			}
		}
		if _, err := parseRunArgs([]string{"--slot", "99"}); err == nil {
			t.Error("out-of-range slot should error")
		}
	})

	t.Run("unknown flag errors", func(t *testing.T) {
		if _, err := parseRunArgs([]string{"--bogus"}); err == nil {
			t.Error("unknown flag should error")
		}
	})
}
