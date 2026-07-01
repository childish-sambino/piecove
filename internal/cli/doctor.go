package cli

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/childish-sambino/piecove/internal/config"
	"github.com/childish-sambino/piecove/internal/dockerx"
)

var providers = map[string]bool{
	"fireworks": true, "zai": true, "openrouter": true,
	"anthropic": true, "bedrock": true, "local": true,
}

// Doctor checks the pieces a working piecove needs and says what's missing.
func Doctor(args []string) error {
	ok := true
	check := func(good bool, label, fix string) {
		if good {
			fmt.Println("  ✓", label)
		} else {
			ok = false
			fmt.Printf("  ✗ %s\n      → %s\n", label, fix)
		}
	}

	fmt.Println("piecove doctor")

	docker, derr := dockerx.Find()
	check(derr == nil, "docker client", "install OrbStack (brew install --cask orbstack) or Docker Desktop")
	if derr == nil {
		runtimeDir, _ := config.RuntimeDir()
		_, cerr := dockerx.New(filepath.Join(runtimeDir, "docker-compose.yml"))
		check(cerr == nil, fmt.Sprintf("compose (%s)", docker), "update docker — the compose plugin is missing")
	}

	p, _ := config.Path()
	cfg, cfgErr := config.Load()
	check(cfgErr == nil, "config at "+p, "run `piecove init`, then set PROVIDER/MODEL/PIECOVE_API_KEY")
	if cfgErr == nil {
		provider := cfg["PROVIDER"]
		check(providers[provider], "PROVIDER="+provider, "set PROVIDER to fireworks|zai|openrouter|anthropic|bedrock|local")
		hasAuth := cfg["PIECOVE_API_KEY"] != "" || provider == "anthropic" || provider == "bedrock" || provider == "local"
		check(hasAuth, "credentials for "+provider, "set PIECOVE_API_KEY (or use PROVIDER=anthropic + `claude` /login for a subscription)")
		if st, err := os.Stat(p); err == nil && st.Mode().Perm()&0o077 != 0 {
			check(false, "config permissions", "chmod 600 "+p+" — it holds API keys")
		}
	}

	home, _ := os.UserHomeDir()
	_, claudeErr := os.Stat(filepath.Join(home, ".claude"))
	check(claudeErr == nil, "~/.claude to mirror", "optional — without it the agents run with default config")

	if !ok {
		return fmt.Errorf("some checks failed")
	}
	fmt.Println("all good — `piecove run ~/code/your-repo`")
	return nil
}
