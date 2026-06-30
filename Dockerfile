# Ruby version — auto-detected from the working dir's .ruby-version / Gemfile by
# run.sh and passed as a build arg. Falls back to a recent default.
ARG RUBY_VERSION=3.4.1
FROM ruby:${RUBY_VERSION}-slim-bookworm

# Node 22, copied from the official image (cleaner than the NodeSource apt repo).
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Toolchains + native-extension build deps. Ruby comes from the base; Node above;
# Python 3.11 from apt. build-essential + the -dev libs let native gems/wheels
# compile (libpq-dev for the `pg` gem); postgresql-client gives psql/pg_isready.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git ripgrep ca-certificates curl less jq \
      build-essential pkg-config libstdc++6 \
      libpq-dev postgresql-client libyaml-dev libffi-dev \
      python3 python3-venv python3-pip \
  && rm -rf /var/lib/apt/lists/*

# GitHub CLI (commit/push, clone private repos).
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs: Claude Code and Pi. Run whichever from the shell.
RUN npm install -g @anthropic-ai/claude-code
RUN npm install -g --ignore-scripts @earendil-works/pi-coding-agent

# Sentry CLI — the new agent-focused `sentry` (getsentry/cli). Pull the latest
# release binary for the image's arch (works on Apple Silicon and Intel hosts).
RUN arch="$(dpkg --print-architecture)"; case "$arch" in arm64) a=arm64 ;; amd64) a=x64 ;; *) a="$arch" ;; esac; \
    curl -fsSL -o /usr/local/bin/sentry "https://github.com/getsentry/cli/releases/latest/download/sentry-linux-$a" \
 && chmod +x /usr/local/bin/sentry

# Service CLIs:
#   linear  — @schpet/linear-cli (npm, community/agent-friendly)
#   heroku  — official Heroku CLI (npm)
#   bs      — Better Stack CLI (sounak98/betterstack-cli, community) release binary, arch-aware
RUN npm install -g @schpet/linear-cli heroku
RUN arch="$(dpkg --print-architecture)"; case "$arch" in arm64) t=aarch64-unknown-linux-gnu ;; amd64) t=x86_64-unknown-linux-gnu ;; *) t="" ;; esac; \
    curl -fsSL "https://github.com/sounak98/betterstack-cli/releases/latest/download/bs-$t.tar.gz" -o /tmp/bs.tgz \
 && tar -xzf /tmp/bs.tgz -C /tmp \
 && mv "$(find /tmp -name bs -type f | head -1)" /usr/local/bin/bs \
 && chmod +x /usr/local/bin/bs && rm -rf /tmp/bs.tgz

# Stub the macOS/mise commands a user's notify hooks may shell out to, so those
# hooks no-op on Linux instead of erroring. `say` is handled separately (forwarded
# to the Mac). `source` is shimmed because Claude Code runs hooks under dash.
RUN for cmd in afplay mise osascript terminal-notifier source; do \
      printf '#!/bin/sh\nexit 0\n' > /usr/local/bin/$cmd && chmod +x /usr/local/bin/$cmd; \
    done

# Headless "browser": agent CLIs call xdg-open/$BROWSER for OAuth URLs; this shim
# hands the URL to a host-mounted file that ./host-bridge opens on the Mac.
COPY browser-open.sh /usr/local/bin/xdg-open
RUN chmod +x /usr/local/bin/xdg-open && cp /usr/local/bin/xdg-open /usr/local/bin/open
ENV BROWSER=/usr/local/bin/xdg-open

# Forward macOS `say` to the Mac so TTS notify hooks play on your speakers
# (./host-bridge --watch runs the real `say`).
COPY say-forward.sh /usr/local/bin/say
RUN chmod +x /usr/local/bin/say

# Non-root user (agent CLIs refuse permissioned modes as root; keeps the named
# config volume owned correctly).
ARG USERNAME=agent
RUN useradd --create-home --shell /bin/bash ${USERNAME}

# Pi permission-gate extension — reads your Claude permissions.allow so Pi enforces
# the same allowlist (gates the bash tool's CLI/network calls). See pi-allowlist.ts.
COPY pi-allowlist.ts /opt/piecove/pi-allowlist.ts

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

USER ${USERNAME}
RUN mkdir -p /home/${USERNAME}/.claude /home/${USERNAME}/.pi/agent /home/${USERNAME}/.sentry

WORKDIR /workspace

# Keep Claude Code's global state (theme, onboarding, per-folder trust) on the
# persisted config volume, not in the ephemeral home.
ENV CLAUDE_CONFIG_DIR=/home/agent/.claude

# Default Postgres connection for the optional db service (used with --db).
ENV PGHOST=localhost PGPORT=5432 PGUSER=postgres PGPASSWORD=postgres

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# Default to a shell: run `claude`, `pi`, or poke around the working dir.
CMD ["bash"]
