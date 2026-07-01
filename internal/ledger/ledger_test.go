package ledger

import (
	"strings"
	"testing"
	"time"
)

const sample = `{"ts":1750000000000,"session":"a","model":"glm-5.2","tier":"standard","usage":{"input":1000,"output":200,"cacheRead":5000,"cacheWrite":0},"cost":0.002}
{"ts":1750000100000,"session":"a","model":"glm-5.2","tier":"local","usage":{"input":500,"output":100,"cacheRead":0,"cacheWrite":0},"cost":0.001}
not json at all
{"ts":1750086400000,"session":"b","model":"claude-opus-4-8","tier":"frontier","usage":{"input":2000,"output":400,"cacheRead":0,"cacheWrite":100},"cost":0.05}
{"broken": true}
`

func TestReadSkipsMalformed(t *testing.T) {
	entries := Read(strings.NewReader(sample))
	if len(entries) != 3 {
		t.Fatalf("got %d entries, want 3 (malformed lines skipped)", len(entries))
	}
}

func TestByModel(t *testing.T) {
	aggs := ByModel(Read(strings.NewReader(sample)))
	if len(aggs) != 2 {
		t.Fatalf("got %d models, want 2", len(aggs))
	}
	if aggs[0].Key != "claude-opus-4-8" {
		t.Errorf("most expensive first: got %q", aggs[0].Key)
	}
	if aggs[1].Calls != 2 || aggs[1].Cost != 0.003 {
		t.Errorf("glm agg = %+v", aggs[1])
	}
	if aggs[1].Usage.Input != 1500 {
		t.Errorf("glm input tokens = %v, want 1500", aggs[1].Usage.Input)
	}
}

func TestByDayAndToday(t *testing.T) {
	entries := Read(strings.NewReader(sample))
	days := ByDay(entries)
	if len(days) != 2 {
		t.Fatalf("got %d days, want 2", len(days))
	}
	if days[0].Key >= days[1].Key {
		t.Error("days should be sorted ascending")
	}

	now := time.UnixMilli(1750000000000)
	today := Today(entries, now)
	if len(today) != 2 {
		t.Errorf("got %d entries for the first day, want 2", len(today))
	}
}

func TestFormatting(t *testing.T) {
	if got := USD(123.4); got != "$123" {
		t.Errorf("USD(123.4) = %q", got)
	}
	if got := USD(1.5); got != "$1.50" {
		t.Errorf("USD(1.5) = %q", got)
	}
	if got := USD(0.0042); got != "$0.004" {
		t.Errorf("USD(0.0042) = %q", got)
	}
	if got := Toks(1_234_567); got != "1.2M" {
		t.Errorf("Toks(1234567) = %q", got)
	}
	if got := Toks(4200); got != "4k" {
		t.Errorf("Toks(4200) = %q", got)
	}
}
