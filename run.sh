#!/usr/bin/env bash
# agentbox — run a coding agent (Claude Code or Pi) in a container against a repo.
#
#   path/to/agentbox/run.sh ~/code/myrepo        # shell in the repo; run `claude` or `pi`
#   path/to/agentbox/run.sh .                     # shell in the current dir
#   path/to/agentbox/run.sh ~/code/myrepo --db    # force-start Postgres
#   path/to/agentbox/run.sh ~/code/myrepo --no-db # skip Postgres even if detected
#   path/to/agentbox/run.sh ~/code/myrepo claude  # run a command instead of a shell
#
# Postgres auto-starts when the repo uses it (a `pg` gem / postgresql database.yml);
# --db / --no-db force it on or off.
set -euo pipefail

# Parse args BEFORE cd-ing into the script's dir, so a relative path like `.`
# resolves against where you invoked run.sh. First directory arg = the workspace;
# anything else is the command to run (default: shell).
WORKSPACE_DIR=""
WANT_DB=auto
CMD=()
for a in "$@"; do
  case "$a" in
    --db) WANT_DB=1 ;;
    --no-db) WANT_DB=0 ;;
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

[ -f .env ] || { echo "No .env — run: cp .env.example .env  (then set PROVIDER/MODEL/AGENTBOX_API_KEY)" >&2; exit 1; }

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
if [ -n "${RV:-}" ]; then export RUBY_VERSION="$RV"; echo "agentbox: detected Ruby $RUBY_VERSION"; fi

# Auto-start Postgres when the repo uses it (overridable with --db / --no-db).
needs_pg() {
  local d="$1"
  grep -qE "^[[:space:]]*gem[[:space:]]+[\"']pg[\"']" "$d/Gemfile" 2>/dev/null && return 0
  grep -qE "adapter:[[:space:]]*postgresql" "$d/config/database.yml" 2>/dev/null && return 0
  return 1
}
if [ "$WANT_DB" = "auto" ]; then
  if needs_pg "$WORKSPACE_DIR"; then
    WANT_DB=1; echo "agentbox: Postgres app detected → starting db (use --no-db to skip)"
  else
    WANT_DB=0
  fi
fi

# Stage the user's own ~/.claude config (CLAUDE.md, skills, settings) for mirroring.
# -L resolves symlinks so it works whether they're real files or links to a dotfiles repo.
STAGE="./.agent-config"
rm -rf "$STAGE"; mkdir -p "$STAGE" .auth
[ -e "$HOME/.claude/CLAUDE.md" ]     && cp -RL "$HOME/.claude/CLAUDE.md"     "$STAGE/CLAUDE.md"     2>/dev/null || true
[ -e "$HOME/.claude/skills" ]        && cp -RL "$HOME/.claude/skills"        "$STAGE/skills"        2>/dev/null || true
[ -e "$HOME/.claude/settings.json" ] && cp -RL "$HOME/.claude/settings.json" "$STAGE/settings.json" 2>/dev/null || true

# git identity from the host (so commits are attributed correctly, no config needed)
export GIT_USER_NAME="$(git config --global user.name  || true)"
export GIT_USER_EMAIL="$(git config --global user.email || true)"

# OrbStack ships compose as `docker-compose`; Docker Desktop as `docker compose`.
if docker compose version >/dev/null 2>&1; then compose() { docker compose "$@"; }; else compose() { docker-compose "$@"; }; fi

# The home volume is external (so `compose down -v` can't wipe your auth/sessions);
# ensure it exists. No-op if present; a fresh one is seeded from the image on first mount.
docker volume create agentbox-home >/dev/null

compose build
if [ "$WANT_DB" = "1" ]; then
  echo "agentbox: starting Postgres (--db)…"
  compose --profile db up -d db
fi
echo "agentbox: working on $WORKSPACE_DIR"
if [ "${#CMD[@]}" -gt 0 ]; then
  compose run --rm agentbox "${CMD[@]}"
else
  compose run --rm agentbox
fi
