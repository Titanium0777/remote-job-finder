#!/bin/sh
# Starts Remote Job Finder on this computer: ./start.sh   then open http://localhost:8765
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  python3 -m venv .venv && .venv/bin/pip install -q -r requirements.txt || exit 1
fi
exec .venv/bin/python local_server.py
