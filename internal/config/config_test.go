package config

import (
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	in := `
# a comment
PROVIDER=openrouter
MODEL=z-ai/glm-5.2

export GH_TOKEN=abc123
QUOTED="hello world"
SINGLE='one two'
EMPTY=
SPACED = padded
not-a-pair
`
	got, err := Parse(strings.NewReader(in))
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"PROVIDER": "openrouter",
		"MODEL":    "z-ai/glm-5.2",
		"GH_TOKEN": "abc123",
		"QUOTED":   "hello world",
		"SINGLE":   "one two",
		"EMPTY":    "",
		"SPACED":   "padded",
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %q, want %q", k, got[k], v)
		}
	}
	if _, ok := got["not-a-pair"]; ok {
		t.Error("bare word should not parse as a key")
	}
}

func TestDirRespectsEnv(t *testing.T) {
	t.Setenv("PIECOVE_HOME", "/tmp/custom-piecove")
	d, err := Dir()
	if err != nil {
		t.Fatal(err)
	}
	if d != "/tmp/custom-piecove" {
		t.Errorf("Dir = %q, want PIECOVE_HOME override", d)
	}
}
