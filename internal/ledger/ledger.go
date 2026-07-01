// Package ledger parses and aggregates the cost-lab ledger (ledger.jsonl,
// written by the pi-costlab extension inside the container) into the spend
// report behind `piecove cost`.
package ledger

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"time"
)

// Usage is token counts for one metered call.
type Usage struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

// Entry is one metered model call.
type Entry struct {
	TS      int64   `json:"ts"` // unix millis
	Session string  `json:"session"`
	Model   string  `json:"model"`
	Tier    string  `json:"tier"`
	Usage   Usage   `json:"usage"`
	Cost    float64 `json:"cost"`
}

// Read parses ledger.jsonl, skipping malformed lines (the ledger is
// append-only telemetry; one bad line shouldn't kill the report).
func Read(r io.Reader) []Entry {
	var out []Entry
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for sc.Scan() {
		var e Entry
		if err := json.Unmarshal(sc.Bytes(), &e); err == nil && e.Model != "" {
			out = append(out, e)
		}
	}
	return out
}

// Agg is an aggregated row (per model or per day).
type Agg struct {
	Key   string
	Calls int
	Cost  float64
	Usage Usage
}

func aggregate(entries []Entry, key func(Entry) string) []Agg {
	m := map[string]*Agg{}
	for _, e := range entries {
		k := key(e)
		a := m[k]
		if a == nil {
			a = &Agg{Key: k}
			m[k] = a
		}
		a.Calls++
		a.Cost += e.Cost
		a.Usage.Input += e.Usage.Input
		a.Usage.Output += e.Usage.Output
		a.Usage.CacheRead += e.Usage.CacheRead
		a.Usage.CacheWrite += e.Usage.CacheWrite
	}
	out := make([]Agg, 0, len(m))
	for _, a := range m {
		out = append(out, *a)
	}
	return out
}

// ByModel aggregates spend per model, most expensive first.
func ByModel(entries []Entry) []Agg {
	out := aggregate(entries, func(e Entry) string { return e.Model })
	sort.Slice(out, func(i, j int) bool { return out[i].Cost > out[j].Cost })
	return out
}

// ByDay aggregates spend per local calendar day, oldest first.
func ByDay(entries []Entry) []Agg {
	out := aggregate(entries, func(e Entry) string {
		return time.UnixMilli(e.TS).Local().Format("2006-01-02")
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}

// Today filters entries to the current local day.
func Today(entries []Entry, now time.Time) []Entry {
	day := now.Local().Format("2006-01-02")
	var out []Entry
	for _, e := range entries {
		if time.UnixMilli(e.TS).Local().Format("2006-01-02") == day {
			out = append(out, e)
		}
	}
	return out
}

// USD formats a dollar amount the way the in-container dashboard does.
func USD(n float64) string {
	switch {
	case n >= 100:
		return fmt.Sprintf("$%.0f", n)
	case n >= 1:
		return fmt.Sprintf("$%.2f", n)
	default:
		return fmt.Sprintf("$%.3f", n)
	}
}

// Toks renders a token count compactly (1.2M, 34k, 999).
func Toks(n float64) string {
	switch {
	case n >= 1e6:
		return fmt.Sprintf("%.1fM", n/1e6)
	case n >= 1e3:
		return fmt.Sprintf("%.0fk", n/1e3)
	default:
		return fmt.Sprintf("%.0f", n)
	}
}

// Render prints the spend report: per-day history then per-model totals.
func Render(w io.Writer, entries []Entry) {
	if len(entries) == 0 {
		fmt.Fprintln(w, "no metered spend yet — the ledger fills up as you run `pi` sessions")
		return
	}
	var total float64
	for _, e := range entries {
		total += e.Cost
	}
	fmt.Fprintf(w, "piecove · %d metered calls · total %s\n\n", len(entries), USD(total))
	fmt.Fprintln(w, "by day")
	for _, a := range ByDay(entries) {
		fmt.Fprintf(w, "  %s  %8s  %4d calls\n", a.Key, USD(a.Cost), a.Calls)
	}
	fmt.Fprintln(w, "\nby model")
	for _, a := range ByModel(entries) {
		name := a.Key
		if len(name) > 40 {
			name = "…" + name[len(name)-39:]
		}
		fmt.Fprintf(w, "  %-40s %8s  in %s · out %s · cached %s\n",
			name, USD(a.Cost), Toks(a.Usage.Input), Toks(a.Usage.Output), Toks(a.Usage.CacheRead))
	}
}
