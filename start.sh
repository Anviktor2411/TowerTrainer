#!/usr/bin/env bash
# Tower Trainer — start the server and open the trainer in your browser (macOS / Linux).
cd "$(dirname "$0")" || exit 1
PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then echo "Python 3 is needed (https://www.python.org/downloads/)"; exit 1; fi
echo "Tower Trainer: http://localhost:8780   (Ctrl+C stops it)"
( sleep 2; (xdg-open "http://localhost:8780/" || open "http://localhost:8780/") >/dev/null 2>&1 ) &
exec "$PY" server.py "$@"
