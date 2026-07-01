// Package detect inspects a working directory to figure out what it needs:
// which Ruby to build, whether Postgres/Redis should start, whether the repo
// is a Rails app worth auto-serving. All pure functions over the filesystem,
// so the launcher stays declarative and testable.
package detect

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

var (
	gemfileRubyRe = regexp.MustCompile(`(?m)^\s*ruby\s+["']([0-9]+\.[0-9]+\.[0-9]+)`)
	pgGemRe       = regexp.MustCompile(`(?m)^\s*gem\s+["']pg["']`)
	redisGemRe    = regexp.MustCompile(`(?m)^\s*gem\s+["'](sidekiq|redis|resque)["']`)
	pgAdapterRe   = regexp.MustCompile(`adapter:\s*postgresql`)
	redisCableRe  = regexp.MustCompile(`adapter:\s*redis`)
	appNameJunk   = regexp.MustCompile(`[^a-z0-9_]+`)
)

func read(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(b)
}

// RubyVersion returns the repo's Ruby version from .ruby-version (preferred)
// or the Gemfile's `ruby "x.y.z"` directive. Empty string when undetectable.
func RubyVersion(dir string) string {
	if v := read(filepath.Join(dir, ".ruby-version")); v != "" {
		v = strings.TrimSpace(v)
		v = strings.TrimPrefix(v, "ruby-")
		if v != "" {
			return v
		}
	}
	if m := gemfileRubyRe.FindStringSubmatch(read(filepath.Join(dir, "Gemfile"))); m != nil {
		return m[1]
	}
	return ""
}

// NeedsPostgres reports whether the repo uses Postgres (pg gem or a
// postgresql adapter in database.yml).
func NeedsPostgres(dir string) bool {
	return pgGemRe.MatchString(read(filepath.Join(dir, "Gemfile"))) ||
		pgAdapterRe.MatchString(read(filepath.Join(dir, "config", "database.yml")))
}

// IsRails reports whether the repo is a Rails app (the auto-serve trigger).
func IsRails(dir string) bool {
	_, err1 := os.Stat(filepath.Join(dir, "config", "application.rb"))
	_, err2 := os.Stat(filepath.Join(dir, "Gemfile"))
	return err1 == nil && err2 == nil
}

// NeedsRedis reports whether a served app needs Redis (sidekiq/redis/resque
// in the Gemfile, or a redis ActionCable adapter).
func NeedsRedis(dir string) bool {
	return redisGemRe.MatchString(read(filepath.Join(dir, "Gemfile"))) ||
		redisCableRe.MatchString(read(filepath.Join(dir, "config", "cable.yml")))
}

// AppName sanitizes a directory basename into a Postgres-safe identifier used
// for per-slot database names.
func AppName(base string) string {
	s := appNameJunk.ReplaceAllString(strings.ToLower(base), "_")
	s = strings.Trim(s, "_")
	if s == "" {
		return "app"
	}
	return s
}

// FreeSlot returns the first slot (0..max) whose port 3000+slot is not
// answering on localhost — how parallel instances of the same app avoid each
// other. When everything up to max is busy, max is returned.
func FreeSlot(max int) int {
	for s := 0; s < max; s++ {
		conn, err := net.DialTimeout("tcp", fmt.Sprintf("localhost:%d", 3000+s), 250*time.Millisecond)
		if err != nil {
			return s
		}
		conn.Close()
	}
	return max
}
