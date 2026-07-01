#!/usr/bin/env bash
# piecove — run a coding agent (Claude Code or Pi) in a container against a repo.
#
#   path/to/piecove/run.sh ~/code/myrepo        # shell in the repo; run `claude` or `pi`
#   path/to/piecove/run.sh .                     # shell in the current dir
#   path/to/piecove/run.sh ~/code/myrepo --db    # force-start Postgres
#   path/to/piecove/run.sh ~/code/myrepo --no-db # skip Postgres even if detected
#   path/to/piecove/run.sh ~/code/myrepo --no-serve # don't auto-boot a Rails app
#   path/to/piecove/run.sh ~/code/myrepo --slot=2 # serve on :3002 with its own db
#   path/to/piecove/run.sh ~/code/myrepo --no-wait # don't block the shell on app boot
#   path/to/piecove/run.sh ~/code/myrepo claude  # run a command instead of a shell
#
# Postgres auto-starts when the repo uses it (a `pg` gem / postgresql database.yml);
# --db / --no-db force it on or off. A Rails app auto-serves (bin/dev + Sidekiq +
# Redis, bootstrapped in the background); --serve / --no-serve force it on or off.
#
# Parallel instances (one worktree per issue): each run.sh gets its own container,
# and each served app gets a SLOT — port 3000+slot, its own Postgres database, and
# its own Redis DB number, so web/schema/Sidekiq queues never cross. The first free
# port is picked automatically; --slot=N pins it.
set -euo pipefail

# Parse args BEFORE cd-ing into the script's dir, so a relative path like `.`
# resolves against where you invoked run.sh. First directory arg = the workspace;
# anything else is the command to run (default: shell).
WORKSPACE_DIR=""
WANT_DB=auto
WANT_SERVE=auto
CMD=()
for a in "$@"; do
  case "$a" in
    --db) WANT_DB=1 ;;
    --no-db) WANT_DB=0 ;;
    --serve) WANT_SERVE=1 ;;
    --no-serve) WANT_SERVE=0 ;;
    --no-wait) export PIECOVE_WAIT=0 ;;
    --slot=*) SLOT_ARG="${a#*=}" ;;
    *)
      if [ -z "$WORKSPACE_DIR" ] && [ -d "$a" ]; then
        WORKSPACE_DIR="$(cd "$a" && pwd)"
      else
        CMD+=("$a")
      fi ;;
  esac
done

cd "$(dirname "$0")"
WORKSPACE_DIR="${WORKSPACE_DIR:-$PWD/workspace}"
export WORKSPACE_DIR

# docker on PATH (OrbStack may not be in a fresh shell's PATH)
if ! command -v docker >/dev/null 2>&1; then
  [ -x "$HOME/.orbstack/bin/docker" ] && export PATH="$HOME/.orbstack/bin:$PATH"
fi
if ! command -v docker >/dev/null 2>&1; then
  [ -x /Applications/OrbStack.app/Contents/MacOS/xbin/docker ] && export PATH="/Applications/OrbStack.app/Contents/MacOS/xbin:$PATH"
fi
command -v docker >/dev/null 2>&1 || { echo "docker not found — install/start OrbStack or Docker Desktop." >&2; exit 1; }

[ -f .env ] || { echo "No .env — run: cp .env.example .env  (then set PROVIDER/MODEL/PIECOVE_API_KEY)" >&2; exit 1; }

# Auto-detect the working dir's Ruby version → build the matching interpreter.
detect_ruby() {
  local d="$1"
  if [ -f "$d/.ruby-version" ]; then
    tr -d ' \t\r' < "$d/.ruby-version" | sed 's/^ruby-//'
  elif [ -f "$d/Gemfile" ]; then
    grep -E "^[[:space:]]*ruby[[:space:]]+[\"']" "$d/Gemfile" | head -1 | sed -E "s/.*[\"']([0-9]+\.[0-9]+\.[0-9]+).*/\1/"
  fi
}
RV="$(detect_ruby "$WORKSPACE_DIR" || true)"
if [ -n "${RV:-}" ]; then export RUBY_VERSION="$RV"; echo "piecove: detected Ruby $RUBY_VERSION"; fi

# Auto-start Postgres when the repo uses it (overridable with --db / --no-db).
needs_pg() {
  local d="$1"
  grep -qE "^[[:space:]]*gem[[:space:]]+[\"']pg[\"']" "$d/Gemfile" 2>/dev/null && return 0
  grep -qE "adapter:[[:space:]]*postgresql" "$d/config/database.yml" 2>/dev/null && return 0
  return 1
}
if [ "$WANT_DB" = "auto" ]; then
  if needs_pg "$WORKSPACE_DIR"; then
    WANT_DB=1; echo "piecove: Postgres app detected → starting db (use --no-db to skip)"
  else
    WANT_DB=0
  fi
fi

# Auto-serve a Rails app: bootstrap + run its dev stack in the background so the
# app is fully up (web, JS, Sidekiq, Redis) with zero config in the repo itself.
is_rails() { [ -f "$1/config/application.rb" ] && [ -f "$1/Gemfile" ]; }
needs_redis() {
  local d="$1"
  grep -qE "^[[:space:]]*gem [\"'](sidekiq|redis|resque)[\"']" "$d/Gemfile" 2>/dev/null && return 0
  grep -qsE "adapter:[[:space:]]*redis" "$d/config/cable.yml" && return 0
  return 1
}
if [ "$WANT_SERVE" = "auto" ]; then
  if is_rails "$WORKSPACE_DIR"; then
    WANT_SERVE=1; echo "piecove: Rails app detected → auto-serving its dev stack (use --no-serve to skip)"
  else
    WANT_SERVE=0
  fi
fi
export PIECOVE_SERVE="$WANT_SERVE"
WANT_REDIS=0
if [ "$WANT_SERVE" = "1" ] && needs_redis "$WORKSPACE_DIR"; then WANT_REDIS=1; fi

# Slot: which parallel instance this is. Port 3000+slot on your Mac; slot >0 also
# gets its own Postgres database and Redis DB number (wired in the entrypoint) so
# parallel worktrees of the same app don't share schema or Sidekiq queues.
PIECOVE_SLOT=0
if [ "$WANT_SERVE" = "1" ]; then
  if [ -n "${SLOT_ARG:-}" ]; then
    PIECOVE_SLOT="$SLOT_ARG"
  else
    while nc -z localhost $((3000 + PIECOVE_SLOT)) >/dev/null 2>&1 && [ "$PIECOVE_SLOT" -lt 10 ]; do
      PIECOVE_SLOT=$((PIECOVE_SLOT + 1))
    done
  fi
  [ "$PIECOVE_SLOT" -gt 0 ] && echo "piecove: slot $PIECOVE_SLOT → app on http://localhost:$((3000 + PIECOVE_SLOT)), isolated db + sidekiq queues"
fi
export PIECOVE_SLOT
# App name for the per-slot database (the container only ever sees /workspace).
export PIECOVE_APP="$(basename "$WORKSPACE_DIR" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9_' '_' | sed 's/_*$//')"

# Stage the user's own ~/.claude config (CLAUDE.md, skills, settings, hooks) for
# mirroring. -L resolves symlinks so it works whether they're real files or links
# to a dotfiles repo. `hooks/` carries claude-notify.sh (the voice-notification
# script); staging it lets both Claude Code and Pi speak from one source.
STAGE="./.agent-config"
rm -rf "$STAGE"; mkdir -p "$STAGE" .auth
[ -e "$HOME/.claude/CLAUDE.md" ]     && cp -RL "$HOME/.claude/CLAUDE.md"     "$STAGE/CLAUDE.md"     2>/dev/null || true
[ -e "$HOME/.claude/skills" ]        && cp -RL "$HOME/.claude/skills"        "$STAGE/skills"        2>/dev/null || true
[ -e "$HOME/.claude/settings.json" ] && cp -RL "$HOME/.claude/settings.json" "$STAGE/settings.json" 2>/dev/null || true
[ -e "$HOME/.claude/hooks" ]         && cp -RL "$HOME/.claude/hooks"         "$STAGE/hooks"         2>/dev/null || true

# git identity from the host (so commits are attributed correctly, no config needed)
export GIT_USER_NAME="$(git config --global user.name  || true)"
export GIT_USER_EMAIL="$(git config --global user.email || true)"

# OrbStack ships compose as `docker-compose`; Docker Desktop as `docker compose`.
if docker compose version >/dev/null 2>&1; then compose() { docker compose "$@"; }; else compose() { docker-compose "$@"; }; fi

# The home volume is external (so `compose down -v` can't wipe your auth/sessions);
# ensure it exists. No-op if present; a fresh one is seeded from the image on first mount.
docker volume create piecove-home >/dev/null

compose build
if [ "$WANT_DB" = "1" ]; then
  echo "piecove: starting Postgres (--db)…"
  compose --profile db up -d db
fi
if [ "$WANT_REDIS" = "1" ]; then
  echo "piecove: starting Redis (app uses sidekiq/redis)…"
  compose --profile redis up -d redis
fi
echo "piecove: working on $WORKSPACE_DIR"
if [ "${#CMD[@]}" -gt 0 ]; then
  compose run --rm piecove "${CMD[@]}"
else
  compose run --rm piecove
fi
