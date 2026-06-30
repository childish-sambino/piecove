#!/usr/bin/env bash
# agentbox entrypoint: mirror the user's Claude config, wire the chosen provider
# for BOTH Claude Code and Pi from one set of vars, set up git/GitHub, then exec
# the command (a shell by default).
set -u

CLAUDE_DIR="$HOME/.claude"
STAGE="/agent-config"          # the user's ~/.claude bits, staged read-only by run.sh
mkdir -p "$CLAUDE_DIR"

# ── Mirror the user's Claude Code config (CLAUDE.md, skills, settings) ─────────
if [ -d "$STAGE" ]; then
  [ -e "$STAGE/CLAUDE.md" ] && ln -sfn "$STAGE/CLAUDE.md" "$CLAUDE_DIR/CLAUDE.md"
  [ -e "$STAGE/skills" ]    && ln -sfn "$STAGE/skills"    "$CLAUDE_DIR/skills"
  if [ -f "$STAGE/settings.json" ]; then
    # Copy (not symlink) so Claude Code can write state; preserve the chosen theme
    # across the refresh so you aren't re-prompted, and auto-approve project MCP.
    THEME=""
    [ -f "$CLAUDE_DIR/settings.json" ] && THEME=$(jq -r '.theme // empty' "$CLAUDE_DIR/settings.json" 2>/dev/null)
    cp -f "$STAGE/settings.json" "$CLAUDE_DIR/settings.json"
    [ -n "$THEME" ] && { tmp=$(mktemp) && jq --arg t "$THEME" '.theme=$t' "$CLAUDE_DIR/settings.json" > "$tmp" && mv "$tmp" "$CLAUDE_DIR/settings.json"; }
    tmp=$(mktemp) && jq '.enableAllProjectMcpServers = true' "$CLAUDE_DIR/settings.json" > "$tmp" && mv "$tmp" "$CLAUDE_DIR/settings.json"
  fi
  # Give Pi the same skills + instructions: it reads ~/.pi/agent/skills (the same
  # Agent Skills SKILL.md standard as Claude) and AGENTS.md as its system prompt,
  # so point both at your mirrored Claude config.
  mkdir -p "$HOME/.pi/agent"
  [ -e "$STAGE/skills" ]    && ln -sfn "$STAGE/skills"    "$HOME/.pi/agent/skills"
  [ -e "$STAGE/CLAUDE.md" ] && ln -sfn "$STAGE/CLAUDE.md" "$HOME/.pi/agent/AGENTS.md"
fi

# ── Resolve the provider preset → base URL + model for both CLIs ───────────────
PROVIDER="${PROVIDER:-fireworks}"
KEY="${AGENTBOX_API_KEY:-}"
A_BASE=""; PI_API="anthropic-messages"; PI_PROVIDER="agentbox"
case "$PROVIDER" in
  fireworks)  A_BASE="https://api.fireworks.ai/inference"; : "${MODEL:=accounts/fireworks/models/glm-5p2}" ;;
  zai)        A_BASE="https://api.z.ai/api/anthropic";     : "${MODEL:=glm-5.2}" ;;
  openrouter) A_BASE="https://openrouter.ai/api";          : "${MODEL:=z-ai/glm-5.2}" ;;
  anthropic)  PI_PROVIDER="anthropic";      : "${MODEL:=claude-opus-4-8}" ;;
  bedrock)    PI_PROVIDER="amazon-bedrock" ;;
  *) echo "agentbox: unknown PROVIDER='$PROVIDER' (use fireworks|zai|openrouter|anthropic|bedrock)" >&2 ;;
esac
MODEL="${MODEL:-}"

# Claude Code wiring
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
if [ "$PROVIDER" = "anthropic" ]; then
  [ -n "$KEY" ]   && export ANTHROPIC_API_KEY="$KEY"
  [ -n "$MODEL" ] && export ANTHROPIC_MODEL="$MODEL"
elif [ "$PROVIDER" = "bedrock" ]; then
  export CLAUDE_CODE_USE_BEDROCK=1   # AWS creds come from the environment
  [ -n "$MODEL" ] && export ANTHROPIC_MODEL="$MODEL"
elif [ -n "$A_BASE" ]; then
  export ANTHROPIC_BASE_URL="$A_BASE"
  [ -n "$KEY" ] && export ANTHROPIC_AUTH_TOKEN="$KEY"
  export ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL"
  export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
  export ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL"
fi

# Pi wiring: a custom-provider models.json for the proxy presets; Pi's built-in
# provider for anthropic/bedrock. apiKey uses $-interpolation so the key isn't
# written to disk in plaintext.
mkdir -p "$HOME/.pi/agent/extensions"
# Pi permission gate: enforce your Claude permissions.allow on Pi's bash tool.
ln -sfn /opt/agentbox/pi-allowlist.ts "$HOME/.pi/agent/extensions/agentbox-allowlist.ts"
if [ -n "$A_BASE" ]; then
  [ -n "$KEY" ] && export AGENTBOX_API_KEY="$KEY"
  cat > "$HOME/.pi/agent/models.json" <<JSON
{ "providers": { "agentbox": { "baseUrl": "$A_BASE", "api": "$PI_API", "apiKey": "\$AGENTBOX_API_KEY", "models": [ { "id": "$MODEL", "name": "agentbox ($PROVIDER)" } ] } } }
JSON
fi
if [ -n "$MODEL" ]; then
  PI_ALIAS="alias pi='pi --provider $PI_PROVIDER --model \"$MODEL\"'"
else
  PI_ALIAS="# set MODEL to enable the pi alias; otherwise: pi --provider $PI_PROVIDER --model <id>"
fi

# `claude-sub` runs Claude Code on your Anthropic SUBSCRIPTION even when the env is
# pointed at another provider — it strips the provider vars so Claude falls back to
# your /login OAuth token (run `claude-sub` then /login once; it persists).
CLAUDE_SUB_ALIAS="alias claude-sub='env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY -u ANTHROPIC_DEFAULT_OPUS_MODEL -u ANTHROPIC_DEFAULT_SONNET_MODEL -u ANTHROPIC_DEFAULT_HAIKU_MODEL -u CLAUDE_CODE_USE_BEDROCK claude'"

# ── git identity + GitHub auth (HTTPS via GH_TOKEN) ───────────────────────────
[ -n "${GIT_USER_NAME:-}" ]  && git config --global user.name  "$GIT_USER_NAME"
[ -n "${GIT_USER_EMAIL:-}" ] && git config --global user.email "$GIT_USER_EMAIL"
git config --global --add safe.directory '*'
if [ -n "${GH_TOKEN:-}" ]; then
  gh auth setup-git 2>/dev/null || true
  git config --global url."https://github.com/".insteadOf "git@github.com:"
  git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"
fi

# ── interactive-shell niceties (the default command is bash) ──────────────────
BASHRC="$HOME/.bashrc"
sed -i '/# >>> agentbox >>>/,/# <<< agentbox <<</d' "$BASHRC" 2>/dev/null || true
cat >> "$BASHRC" <<RC
# >>> agentbox >>>
$PI_ALIAS
$CLAUDE_SUB_ALIAS
echo "agentbox · provider=$PROVIDER model=${MODEL:-<none>} · run 'claude' or 'pi' (cwd: \$PWD)"
echo "          'claude-sub' = Claude Code on your Anthropic subscription (/login once)"
# <<< agentbox <<<
RC

exec "$@"
