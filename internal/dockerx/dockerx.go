// Package dockerx locates a docker client (including OrbStack installs that
// aren't on a fresh shell's PATH) and provides a thin runner for compose
// invocations against piecove's materialized runtime dir.
package dockerx

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
)

// wellKnown are docker client locations probed when `docker` isn't on PATH.
func wellKnown() []string {
	home, _ := os.UserHomeDir()
	return []string{
		filepath.Join(home, ".orbstack", "bin", "docker"),
		"/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
		"/usr/local/bin/docker",
		"/opt/homebrew/bin/docker",
	}
}

// Find returns the docker client path.
func Find() (string, error) {
	if p, err := exec.LookPath("docker"); err == nil {
		return p, nil
	}
	for _, p := range wellKnown() {
		if st, err := os.Stat(p); err == nil && st.Mode()&0o111 != 0 {
			return p, nil
		}
	}
	return "", errors.New("docker not found — install/start OrbStack (recommended on macOS) or Docker Desktop")
}

// Client is a docker client bound to a compose file.
type Client struct {
	docker      string
	composeFile string
	composeSub  bool   // true: `docker compose`; false: standalone docker-compose
	composeBin  string // standalone docker-compose path when composeSub is false
}

// New builds a Client for the compose file at composeFile. Compose resolution:
// the `docker compose` plugin, then a standalone `docker-compose` on PATH, then
// one next to the docker binary (OrbStack ships it as a sibling, not a plugin).
func New(composeFile string) (*Client, error) {
	docker, err := Find()
	if err != nil {
		return nil, err
	}
	c := &Client{docker: docker, composeFile: composeFile}
	probe := exec.Command(docker, "compose", "version")
	probe.Stdout, probe.Stderr = nil, nil
	if probe.Run() == nil {
		c.composeSub = true
		return c, nil
	}
	if p, err := exec.LookPath("docker-compose"); err == nil {
		c.composeBin = p
		return c, nil
	}
	sibling := filepath.Join(filepath.Dir(docker), "docker-compose")
	if st, err := os.Stat(sibling); err == nil && st.Mode()&0o111 != 0 {
		c.composeBin = sibling
		return c, nil
	}
	return nil, errors.New("docker is present but compose isn't (`docker compose` failed and no docker-compose) — update your docker install")
}

// command assembles a compose invocation with extraEnv appended to the
// process env (compose reads interpolation vars from there).
func (c *Client) command(extraEnv []string, args ...string) *exec.Cmd {
	var cmd *exec.Cmd
	base := []string{"-f", c.composeFile}
	if c.composeSub {
		cmd = exec.Command(c.docker, append([]string{"compose"}, append(base, args...)...)...)
	} else {
		cmd = exec.Command(c.composeBin, append(base, args...)...)
	}
	cmd.Env = append(os.Environ(), extraEnv...)
	return cmd
}

// Compose runs a compose command wired to the terminal.
func (c *Client) Compose(extraEnv []string, args ...string) error {
	cmd := c.command(extraEnv, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// EnsureVolume creates a named volume if missing (no-op when present). The
// home volume is external in the compose file so `compose down -v` can't wipe
// agent auth/sessions; this keeps it existing.
func (c *Client) EnsureVolume(name string) error {
	cmd := exec.Command(c.docker, "volume", "create", name)
	cmd.Stdout = nil
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

// Docker runs a raw docker command wired to the terminal.
func (c *Client) Docker(args ...string) error {
	cmd := exec.Command(c.docker, args...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	return cmd.Run()
}

// DockerOutput runs a raw docker command and returns stdout.
func (c *Client) DockerOutput(args ...string) ([]byte, error) {
	return exec.Command(c.docker, args...).Output()
}
