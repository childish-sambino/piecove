package runtime

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMaterialize(t *testing.T) {
	dir := t.TempDir()
	if err := Materialize(dir); err != nil {
		t.Fatal(err)
	}
	mustExist := []string{
		"docker-compose.yml",
		"Dockerfile",
		"entrypoint.sh",
		"serve.sh",
		"config.env.example",
		"pricing.json",
		"shims/browser-open.sh",
		"shims/say-forward.sh",
		"extensions/pi-allowlist.ts",
		"extensions/pi-costlab.ts",
		"extensions/pi-notify.ts",
		"bench/run.sh",
		"bench/scorecard.mjs",
		"bench/tasks.json",
	}
	for _, rel := range mustExist {
		st, err := os.Stat(filepath.Join(dir, rel))
		if err != nil {
			t.Errorf("missing %s: %v", rel, err)
			continue
		}
		if filepath.Ext(rel) == ".sh" && st.Mode()&0o111 == 0 {
			t.Errorf("%s should be executable", rel)
		}
	}
}

func TestMaterializeRefreshesModeAndContent(t *testing.T) {
	dir := t.TempDir()
	if err := Materialize(dir); err != nil {
		t.Fatal(err)
	}
	// Simulate a stale, hand-edited runtime: content drift and lost exec bit.
	target := filepath.Join(dir, "entrypoint.sh")
	if err := os.WriteFile(target, []byte("tampered"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Materialize(dir); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(target)
	if string(b) == "tampered" {
		t.Error("Materialize should overwrite drifted content")
	}
	st, _ := os.Stat(target)
	if st.Mode()&0o111 == 0 {
		t.Error("Materialize should restore the exec bit")
	}
}

func TestConfigExample(t *testing.T) {
	b, err := ConfigExample()
	if err != nil {
		t.Fatal(err)
	}
	if len(b) == 0 {
		t.Fatal("empty config example")
	}
}
