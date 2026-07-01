#!/bin/sh
# Stand-in for macOS `say` inside the container. claude-notify.sh runs
# `say -v <voice> -o <file> <text>` for TTS notifications, but there's no audio
# device here — so drop the voice + text into a host-mounted queue. The watcher
# on your host (piecove bridge --watch) plays it through a real TTS engine.
voice=""
text=""
while [ $# -gt 0 ]; do
  case "$1" in
    -v) voice="$2"; shift 2 ;;
    -o) shift 2 ;;            # ignore the "write to file" path — we forward text
    --) shift ;;
    *)  text="$1"; shift ;;
  esac
done

[ -n "$text" ] || exit 0
mkdir -p /auth/say 2>/dev/null || exit 0
# Timestamped name so the watcher plays utterances in order.
f=$(mktemp "/auth/say/$(date +%s%N)-XXXXXX" 2>/dev/null) || exit 0
{ printf '%s\n' "$voice"; printf '%s\n' "$text"; } > "$f" 2>/dev/null || true
exit 0
