package detect

import (
	"os"
	"path/filepath"
	"testing"
)

func write(t *testing.T, dir, rel, content string) {
	t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestRubyVersion(t *testing.T) {
	cases := []struct {
		name  string
		files map[string]string
		want  string
	}{
		{"ruby-version file", map[string]string{".ruby-version": "3.3.6\n"}, "3.3.6"},
		{"ruby- prefix stripped", map[string]string{".ruby-version": "ruby-3.2.2"}, "3.2.2"},
		{"gemfile directive", map[string]string{"Gemfile": "source \"https://rubygems.org\"\nruby \"3.4.1\"\n"}, "3.4.1"},
		{"gemfile single quotes", map[string]string{"Gemfile": "ruby '3.1.0'\n"}, "3.1.0"},
		{"ruby-version wins over gemfile", map[string]string{".ruby-version": "3.3.0", "Gemfile": "ruby \"3.4.1\""}, "3.3.0"},
		{"commented gemfile ruby ignored", map[string]string{"Gemfile": "# ruby \"9.9.9\"\n"}, ""},
		{"nothing", nil, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			for rel, content := range tc.files {
				write(t, dir, rel, content)
			}
			if got := RubyVersion(dir); got != tc.want {
				t.Errorf("RubyVersion = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestNeedsPostgres(t *testing.T) {
	dir := t.TempDir()
	if NeedsPostgres(dir) {
		t.Error("empty dir should not need postgres")
	}
	write(t, dir, "Gemfile", "gem \"rails\"\ngem \"pg\"\n")
	if !NeedsPostgres(dir) {
		t.Error("pg gem should trigger postgres")
	}

	dir2 := t.TempDir()
	write(t, dir2, "config/database.yml", "development:\n  adapter: postgresql\n")
	if !NeedsPostgres(dir2) {
		t.Error("postgresql adapter should trigger postgres")
	}

	dir3 := t.TempDir()
	write(t, dir3, "Gemfile", "gem \"pgvector-client\"\n") // not the pg gem
	if NeedsPostgres(dir3) {
		t.Error("pg-prefixed gem name should not trigger postgres")
	}
}

func TestIsRailsAndNeedsRedis(t *testing.T) {
	dir := t.TempDir()
	if IsRails(dir) {
		t.Error("empty dir is not rails")
	}
	write(t, dir, "config/application.rb", "module App; end\n")
	write(t, dir, "Gemfile", "gem \"rails\"\n")
	if !IsRails(dir) {
		t.Error("application.rb + Gemfile is rails")
	}
	if NeedsRedis(dir) {
		t.Error("no sidekiq/redis yet")
	}
	write(t, dir, "Gemfile", "gem \"rails\"\ngem 'sidekiq'\n")
	if !NeedsRedis(dir) {
		t.Error("sidekiq gem should trigger redis")
	}

	dir2 := t.TempDir()
	write(t, dir2, "config/cable.yml", "production:\n  adapter: redis\n")
	if !NeedsRedis(dir2) {
		t.Error("redis cable adapter should trigger redis")
	}
}

func TestAppName(t *testing.T) {
	cases := map[string]string{
		"MyApp":        "myapp",
		"my-app.rails": "my_app_rails",
		"app-issue-42": "app_issue_42",
		"---":          "app",
		"":             "app",
	}
	for in, want := range cases {
		if got := AppName(in); got != want {
			t.Errorf("AppName(%q) = %q, want %q", in, got, want)
		}
	}
}
