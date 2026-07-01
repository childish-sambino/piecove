// piecove — run a coding agent (Claude Code or Pi) in an isolated container
// against any repo, pointed at any model/provider, with minimal setup.
//
// The binary is self-contained: the container definition (Dockerfile, compose
// file, entrypoint, Pi extensions) is embedded and materialized into
// ~/.piecove/runtime on each run, so `go install` is a complete install.
package main

import (
	"fmt"
	"os"
	"runtime/debug"

	"github.com/childish-sambino/piecove/internal/cli"
)

var version = "" // set via -ldflags "-X main.version=..."; else module build info

func resolveVersion() string {
	if version != "" {
		return version
	}
	if info, ok := debug.ReadBuildInfo(); ok && info.Main.Version != "" && info.Main.Version != "(devel)" {
		return info.Main.Version // populated by `go install module@version`
	}
	return "dev"
}

const usage = `piecove — run a coding agent in an isolated container against any repo

Usage:
  piecove init                 write ~/.piecove/config.env, then edit it
  piecove run [path] [flags] [-- cmd...]
                               shell (or cmd) in a container at the repo
  piecove bridge [--watch]     on your host: open OAuth URLs, play TTS
  piecove cost [--all]         spend report from the cost-lab ledger
  piecove doctor               check docker, config, volumes
  piecove version              print the version

Run flags:
  --db / --no-db               force Postgres on/off (default: auto-detect)
  --serve / --no-serve         force Rails auto-serve on/off (default: auto)
  --slot N                     pin the parallel-instance slot (port 3000+N)
  --no-wait                    don't block shell entry on the app booting

Examples:
  piecove run ~/code/your-repo           # shell at the repo; run claude or pi
  piecove run .                          # shell at the current dir
  piecove run ~/code/app -- claude       # run a command instead of a shell
`

func main() {
	if len(os.Args) < 2 {
		fmt.Print(usage)
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "init":
		err = cli.Init(os.Args[2:])
	case "run":
		err = cli.Run(os.Args[2:])
	case "bridge":
		err = cli.Bridge(os.Args[2:])
	case "cost":
		err = cli.Cost(os.Args[2:])
	case "doctor":
		err = cli.Doctor(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Println("piecove", resolveVersion())
	case "help", "--help", "-h":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "piecove: unknown command %q\n\n%s", os.Args[1], usage)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "piecove:", err)
		os.Exit(1)
	}
}
