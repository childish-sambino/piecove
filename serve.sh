#!/usr/bin/env bash
# piecove-serve — bootstrap and run the mounted Rails app's dev stack.
#
# Auto-launched (backgrounded) by the entrypoint when the workspace is a Rails app
# (run.sh --no-serve skips it, --serve forces it). It runs the app's OWN dev setup
# — bin/dev / Procfile.dev — rather than imposing one, and only fills the gaps:
#   bundle install        when gems are missing (cached in the piecove-bundle volume)
#   JS deps               npm / yarn / pnpm, picked by lockfile, when package.json exists
#   bin/rails db:prepare  create + migrate the dev database (Postgres via --db service)
#   sidekiq               when the Gemfile has it but the app's dev processes don't run it
#
# Logs to /tmp/piecove-serve.log — `serve-logs` tails it, `serve-stop` kills the
# stack, `serve-start` relaunches it.
set -u
cd /workspace || exit 1
LOG=/tmp/piecove-serve.log
# Idempotent: take down any previous stack (ours is its own setsid group) so a
# restart can't double-run Sidekiq/watchers alongside orphans of a failed boot.
OLD_PID="$(cat /tmp/piecove-serve.pid 2>/dev/null)"
[ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ] && kill -- -"$OLD_PID" 2>/dev/null
echo $$ > /tmp/piecove-serve.pid
exec >> "$LOG" 2>&1

echo "── piecove-serve start (port ${PORT:-3000}) ──"

# A pidfile left in the bind-mounted repo by a previous container makes Puma
# refuse to boot ("A server is already running") — the pid is from a dead
# container's namespace. Nothing is running in THIS fresh container; clear it.
rm -f tmp/pids/server.pid

# Bootstrap only what's missing, so warm starts go straight to the processes.
if [ -f Gemfile ] && ! bundle check >/dev/null 2>&1; then
  echo "→ bundle install"
  bundle install || { echo "✗ bundle install failed — fix, then run 'serve-start'"; exit 1; }
fi
if [ -f package.json ]; then
  if   [ -f pnpm-lock.yaml ]; then JS="pnpm install --frozen-lockfile"
  elif [ -f yarn.lock ];      then JS="yarn install --frozen-lockfile"
  else                             JS="npm install"
  fi
  echo "→ $JS"
  $JS || echo "✗ JS install failed (continuing — the web process may still boot)"
fi
if [ -f bin/rails ]; then
  echo "→ bin/rails db:prepare"
  bin/rails db:prepare || echo "✗ db:prepare failed (continuing — is Postgres up? run.sh --db)"
fi

# Sidekiq gap-fill: the Gemfile wants it but the app's dev entry doesn't run it.
if grep -qE "^[[:space:]]*gem [\"']sidekiq[\"']" Gemfile 2>/dev/null \
   && ! grep -qsE "sidekiq" Procfile.dev bin/dev 2>/dev/null; then
  echo "→ sidekiq (not in the app's dev processes — running it alongside)"
  bundle exec sidekiq &
fi

# The app's own dev entry, verbatim.
if [ -x bin/dev ]; then
  echo "→ bin/dev"
  exec bin/dev
elif [ -f Procfile.dev ]; then
  command -v foreman >/dev/null 2>&1 || { echo "→ gem install foreman"; gem install foreman; }
  echo "→ foreman start -f Procfile.dev -p ${PORT:-3000}"
  exec foreman start -f Procfile.dev -p "${PORT:-3000}"
elif [ -f bin/rails ]; then
  echo "→ bin/rails server"
  exec bin/rails server -b 0.0.0.0
else
  echo "nothing to serve (no bin/dev, Procfile.dev, or bin/rails)"
fi
