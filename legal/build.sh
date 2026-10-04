#!/usr/bin/env bash
# Rebuild legal/legal-pack.docx and the in-app legal pages from the Markdown files.
set -euo pipefail
cd "$(dirname "$0")"
PY="${PYTHON:-/workspace/.venv-legal/bin/python}"
[ -x "$PY" ] || PY=python3
"$PY" build.py
