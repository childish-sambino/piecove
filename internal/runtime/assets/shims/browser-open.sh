#!/bin/sh
# Stand-in "browser" for the container. Claude Code calls this (via xdg-open /
# $BROWSER) to open an OAuth URL, but there's no GUI in here. Instead of making
# you copy a line-wrapped URL out of the terminal, write it to a host-mounted
# file that `piecove bridge` on your host opens in your real browser.
URL="$1"
mkdir -p /auth 2>/dev/null
printf '%s\n' "$URL" > /auth/latest-url.txt 2>/dev/null
echo "→ Auth URL handed off to your host (~/.piecove/auth/latest-url.txt)."
echo "  Run 'piecove bridge' on your host to open it (or 'piecove bridge --watch' for hands-free)."
printf '%s\n' "$URL"
