#!/bin/bash
# Drives the CLI from a script, one line at a time.
#
# Input is fed through a FIFO with a pause between lines, because the CLI reads
# a line only once it is ready for one: everything piped in before the prompt
# exists is dropped. That is also true of the plain readline it used before Ink,
# so the pause is the harness, not a workaround for the UI.
#
#   scripts/drive-cli.sh <workdir> <output-file> <seconds-between-lines> <line>...
#
# KIRA_TTY=1 runs it under a pseudo-terminal, which is what selects the Ink
# renderer; without it the CLI sees a pipe and writes plain lines.
set -u
WORKDIR="$1"; shift
OUT="$1"; shift
DELAY="$1"; shift

FIFO=$(mktemp -u /tmp/kira-cli-fifo.XXXXXX)
mkfifo "$FIFO"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKDIR"

if [ "${KIRA_TTY:-}" = "1" ]; then
  # `script` allocates the pty and forwards what it reads on stdin into it.
  script -qec "node $REPO/bin/kira-code.mjs" /dev/null < "$FIFO" > "$OUT" 2>&1 &
else
  node "$REPO/bin/kira-code.mjs" < "$FIFO" > "$OUT" 2>&1 &
fi
CLI_PID=$!

exec 3> "$FIFO"

for line in "$@"; do
  sleep "$DELAY"
  printf '%s\n' "$line" >&3
done

sleep "$DELAY"
printf '/exit\n' >&3
sleep 3
exec 3>&-

wait $CLI_PID 2>/dev/null
rm -f "$FIFO"
echo "--- exit ---"
