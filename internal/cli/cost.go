package cli

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/childish-sambino/piecove/internal/config"
	"github.com/childish-sambino/piecove/internal/dockerx"
	"github.com/childish-sambino/piecove/internal/ledger"
)

const ledgerPath = "/home/agent/.pi/agent/piecove-cost/ledger.jsonl"

// Cost renders a spend report from the cost-lab ledger, which lives in the
// piecove-home volume (written by the pi-costlab extension in-container).
func Cost(args []string) error {
	fs := flag.NewFlagSet("cost", flag.ContinueOnError)
	today := fs.Bool("today", false, "only today's spend")
	if err := fs.Parse(args); err != nil {
		return err
	}

	runtimeDir, err := config.RuntimeDir()
	if err != nil {
		return err
	}
	client, err := dockerx.New(filepath.Join(runtimeDir, "docker-compose.yml"))
	if err != nil {
		return err
	}
	// Read the ledger straight out of the volume; entrypoint bypassed since
	// this is a read, not a session. cat failing just means no ledger yet.
	out, err := client.DockerOutput("run", "--rm",
		"-v", "piecove-home:/home/agent:ro",
		"--entrypoint", "cat", "piecove", ledgerPath)
	if err != nil {
		out = nil
	}
	entries := ledger.Read(bytes.NewReader(out))
	if *today {
		entries = ledger.Today(entries, time.Now())
	}
	ledger.Render(os.Stdout, entries)
	if err != nil && len(entries) == 0 {
		fmt.Println("(no ledger found — either nothing has been metered yet, or the piecove image isn't built; run `piecove run` once)")
	}
	return nil
}
