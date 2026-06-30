# piecove

Run a coding agent — **Claude Code** or **Pi** — in an isolated container against any repo,
pointed at any model/provider, with minimal setup. Clone it, point it at a working dir, and
you're in a shell with both agents installed, your config mirrored, and your tooling ready.

```bash
git clone git@github.com:childish-sambino/piecove.git ~/Workspace/piecove
cd ~/Workspace/piecove
cp .env.example .env          # set PROVIDER + MODEL + PIECOVE_API_KEY
./run.sh ~/code/your-repo     # shell at the repo; run `claude` or `pi`
```

## Why

- **Isolation.** The agent only sees the working dir you mount (plus your read-only config).
  It can't touch the rest of your machine, so you can let it run freely.
- **Any model, any provider.** One set of vars (`PROVIDER` / `MODEL` / `PIECOVE_API_KEY`)
  wires up *both* Claude Code and Pi. Swap GLM-5.2 on Fireworks for Claude on Anthropic by
  editing one line.
- **Minimal setup.** Ruby version is auto-detected from the repo; Postgres auto-starts when
  the repo needs it; git identity and your `~/.claude` config come from your machine. A
  teammate's whole setup is: clone, set a key, run.

## What's in the box

| Tool | Command | Notes |
|---|---|---|
| Claude Code | `claude` | Anthropic's CLI, pointed at your configured provider |
| Pi | `pi` | badlogic/earendil's minimal agent CLI |
| GitHub CLI | `gh` | commit/push, clone private repos (token auth) |
| Sentry CLI | `sentry` | the new agent-focused CLI (`sentry issue explain …`) |
| Linear CLI | `linear` | issues/cycles/PRs from the shell (community, agent-friendly) |
| Heroku CLI | `heroku` | official |
| Better Stack | `bs` | logs/monitors/incidents, `-o json` everywhere (community) |
| Toolchains | `ruby` `node` `python3` | Ruby auto-detected per repo; Node 22 + Python 3.11 |

Plus `git`, `ripgrep`, `psql`, and native-build libs so most gems/wheels compile.

## Prerequisites

A container runtime providing `docker` + compose. **OrbStack** is recommended on macOS
(`brew install --cask orbstack`) — fast, light, host networking that "just works." Docker
Desktop or Colima also work.

## Setup

```bash
cp .env.example .env
```

Set three things in `.env`:

- `PROVIDER` — `fireworks` | `zai` | `openrouter` | `anthropic` | `bedrock`
- `MODEL` — leave blank for the provider default, or pick one
- `PIECOVE_API_KEY` — your key for that provider (blank for an Anthropic subscription; see below)

Then run it against a repo:

```bash
./run.sh ~/code/your-repo         # shell in the repo
./run.sh .                         # shell in the current dir
./run.sh ~/code/your-repo --db     # force-start Postgres
./run.sh ~/code/your-repo --no-db  # skip Postgres even if detected
./run.sh ~/code/your-repo claude   # run a command instead of a shell
```

You land in a bash shell at `/workspace` (your repo). Run `claude`, run `pi`, or look around.
The shell banner reminds you of the active provider/model and the `claude-sub` shortcut.

## Providers

One key, both CLIs. The preset resolves the right endpoint and wires Claude Code's env *and*
a generated Pi `~/.pi/agent/models.json`:

| `PROVIDER` | Endpoint | Default `MODEL` | Notes |
|---|---|---|---|
| `fireworks` | api.fireworks.ai | `accounts/fireworks/models/glm-5p2` | Zero data retention by default |
| `zai` | api.z.ai | `glm-5.2` | Cheap; no explicit "won't train" guarantee |
| `openrouter` | openrouter.ai | `z-ai/glm-5.2` | One key, many models incl. Claude; set account ZDR |
| `anthropic` | api.anthropic.com | `claude-opus-4-8` | Real Claude; key, or blank for subscription |
| `bedrock` | AWS | (set `MODEL`) | Set `AWS_*` in `.env` instead of a key |

## The two agents

Both are preinstalled; run whichever from the shell.

- **`claude`** (Claude Code) — configured via the env the entrypoint sets
  (`ANTHROPIC_BASE_URL`, token, model). Works for every preset.
- **`pi`** (Pi) — the entrypoint generates `~/.pi/agent/models.json` for the proxy presets and
  aliases `pi` to `pi --provider … --model …`, so it uses your configured model with no flags.
  Pi also gets the **same skills and instructions** as Claude Code: your `~/.claude/skills`
  are symlinked to `~/.pi/agent/skills` (same `SKILL.md` standard) and your `CLAUDE.md` becomes
  Pi's `~/.pi/agent/AGENTS.md`.

> Pi's per-provider endpoint handling is wired from its docs; if a provider misbehaves, tweak
> `~/.pi/agent/models.json` (it regenerates each run).

## Using your Anthropic subscription

To use a Claude Pro/Max plan instead of an API key:

- Set `PROVIDER=anthropic` and leave `PIECOVE_API_KEY` blank, then run `claude` → `/login`.
- Or, while pointed at *another* provider, run **`claude-sub`** — a shortcut that strips the
  provider env vars for that one invocation so Claude Code falls back to your subscription
  login. So `claude`/`pi` stay on your cheap default and `claude-sub` is your plan, one word away.

The OAuth login persists in the home volume (log in once). Claude Code is first-party so it
draws on your plan; Pi can `/login` too, but Anthropic meters third-party harnesses per-token
as extra usage, so an API key or open-model provider is more predictable for Pi.

## Permission allowlist (gating CLI/network calls)

The container is the filesystem sandbox, but the agent can still make outward calls (`gh push`,
`curl`, `psql` to prod). To gate those:

- **Claude Code** uses its native `permissions.allow` from your `settings.json`.
- **Pi** gets a bundled extension (`pi-allowlist.ts`, auto-loaded) that reads the **same**
  `~/.claude/settings.json` `permissions.allow`/`deny` — so you define patterns in **one place**
  and both agents honor them. It gates the `bash` tool: allowlisted commands run, denied ones
  are blocked, anything else **prompts** (Allow once / Allow for session / Reject). Compound
  commands are split on `&& || ; |`, so an allowed prefix can't smuggle in an unapproved call.
  Headless (no UI) → unmatched commands are blocked, fail-safe.

## Sentry CLI

The `sentry` CLI is installed and its login persists across runs. It has a `--read-only` flag
made for agents (read-only scopes; can't mutate Sentry):

```bash
sentry auth login --read-only          # OAuth (opens via host-bridge)
#   or: sentry auth login --token <token> --read-only
sentry issue list ; sentry issue explain <id>
```

This is separate from a Sentry MCP server (which has its own auth); both can coexist.

## What's auto-detected

- **Ruby version** — from the working dir's `.ruby-version`, falling back to the Gemfile's
  `ruby` directive; the image builds that interpreter. Node 22 + Python 3.11 are baked in.
- **Postgres** — auto-starts when the repo uses it (`pg` gem or postgresql `database.yml`).
- **Git identity** — from your host `git config --global user.name`/`user.email`.
- **Your Claude config** — `~/.claude/CLAUDE.md`, `skills/`, and `settings.json` are staged
  (symlinks resolved) and mirrored to *both* agents; project `.mcp.json` servers are
  auto-approved.

## GitHub access

Set `GH_TOKEN` in `.env` (fine-grained, expiring, scoped to the repos you need). The entrypoint
runs `gh auth setup-git` and rewrites GitHub SSH remotes to HTTPS, so `git push`, `git clone`,
and `gh` authenticate via the token — no SSH keys in the container. The agent can read its own
env, so keep the token's scope small and revocable.

## Postgres (for specs)

`postgres:16` auto-starts when the repo uses Postgres (override with `--db` / `--no-db`). It's
reachable at `localhost:5432` (host networking), with `PGHOST`/`PGUSER`/`PGPASSWORD` baked in so
a Rails app connects with no config. Data persists in a volume. First run per repo:

```bash
RAILS_ENV=test bin/rails db:prepare && bundle exec rspec
```

## Container ↔ Mac bridge (`host-bridge`)

The container can't open your browser or reach your speakers, so two things are handed to your
Mac via `./.auth`, and `host-bridge.sh` (run on your Mac) handles them:

- **OAuth URLs** — MCP/agent/`gh`/`sentry` logins write the URL to a file; `host-bridge` opens
  it in your real browser (no clicking line-wrapped links). The callback reaches the container
  via host networking.
- **Voice notifications** — TTS hooks' `say` calls are forwarded; `host-bridge --watch` plays
  them through your Mac's real `say`.

```bash
./host-bridge --watch     # side tab: opens auth URLs AND speaks notifications
./host-bridge             # one-shot: open a pending auth URL
```

## Persistence & volumes

Two named volumes (one per state lifecycle):

- **`piecove-home`** (external) — all your agent state in one place: Claude Code auth/sessions,
  Pi auth, Sentry login, shell history. Marked `external` so `docker compose down -v` can't wipe
  it; `run.sh` ensures it exists. Remove deliberately with `docker volume rm piecove-home`.
- **`piecove-pgdata`** — disposable Postgres data, only with `--db`, recreatable via `db:prepare`.

Everything else is a bind mount: your repo (`/workspace`), your staged config (`/agent-config`,
read-only), and the `./.auth` handoff dir.

## Isolation & data privacy

The agent is jailed to the mounted working dir (filesystem isolation), and the allowlist gates
its outward `bash` calls. Host networking is on (needed for OAuth callbacks and a local DB), so
the container shares your Mac's network — no network isolation. **Whether your code trains a
model depends on the provider:** Fireworks is zero-retention by default; OpenRouter is ZDR only
if you set the account data policy to deny training/retention; Z.ai has no explicit no-train
commitment. Pick the provider that matches your sensitivity.

## Notes & gotchas

- Prompt caching is Anthropic-specific; non-Anthropic providers may ignore it, so expect to pay
  full input tokens each turn.
- Running a test suite needs the repo's deps installed in the container (`bundle install` /
  `npm install`) — host builds are the wrong platform. Add system libs to the Dockerfile if a
  native gem/wheel needs one.
- Pi wiring (models.json, skills, allowlist) is built to Pi's docs; confirm it on your first Pi
  session and adjust `~/.pi/agent/models.json` if a provider's endpoint differs.
- `.env`, `.auth/`, and `.agent-config/` are gitignored — never commit your keys.

## Layout

```text
run.sh              launcher: resolves the repo, auto-detects Ruby/Postgres, builds, runs
Dockerfile          the image: toolchains + Claude Code + Pi + gh + sentry
entrypoint.sh       wires the provider, mirrors config, sets up git/auth, drops to a shell
docker-compose.yml  the piecove service (+ optional db) and volumes
pi-allowlist.ts     Pi extension enforcing your Claude permissions.allow
host-bridge.sh      Mac-side: opens OAuth URLs and plays voice notifications
browser-open.sh     in-container browser shim (hands OAuth URLs to the Mac)
say-forward.sh      in-container `say` shim (forwards TTS to the Mac)
.env.example        all configuration options
```
