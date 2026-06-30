#!/usr/bin/env bash
# Bridges the container to your Mac. Run from your Mac.
#
#   ./host-bridge            # open the OAuth URL waiting from the last auth attempt
#   ./host-bridge --watch    # keep opening auth URLs AND playing voice notifications
#                            # (run this in a background tab while you work)
#
# The container hands off OAuth URLs and TTS notifications into ./.auth; this
# script opens the URLs in your real browser and speaks notifications through the
# real macOS `say`.
set -euo pipefail
cd "$(dirname "$0")"
URLFILE=".auth/latest-url.txt"
SAYDIR=".auth/say"

open_url() {
  [ -s "$URLFILE" ] || return 1
  local url; url="$(cat "$URLFILE")"
  [ -n "$url" ] || return 1
  open "$url"
  rm -f "$URLFILE"
  echo "Opened: $url"
}

say_pending() {
  [ -d "$SAYDIR" ] || return 0
  local f voice text
  for f in $(ls "$SAYDIR" 2>/dev/null | sort); do
    f="$SAYDIR/$f"
    [ -f "$f" ] || continue
    voice="$(sed -n '1p' "$f")"
    text="$(sed -n '2,$p' "$f")"
    rm -f "$f"
    [ -n "$text" ] || continue
    if [ -n "$voice" ]; then say -v "$voice" "$text"; else say "$text"; fi
  done
}

if [[ "${1:-}" == "--watch" ]]; then
  echo "Watching for auth URLs and voice notifications… (Ctrl-C to stop)"
  mkdir -p "$SAYDIR"
  rm -f "$SAYDIR"/* 2>/dev/null || true   # drop any backlog so the watcher doesn't dump old notifications
  while true; do
    open_url || true
    say_pending || true
    sleep 1
  done
else
  open_url || { echo "No auth URL waiting in $URLFILE. (Use --watch to also play voice notifications.)" >&2; exit 1; }
fi
