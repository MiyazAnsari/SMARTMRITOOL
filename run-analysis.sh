#!/usr/bin/env bash
# Run the inter-rater analysis using this project's virtual environment.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -x .venv/bin/python ]]; then
  echo "Virtual environment not found. Create it with:"
  echo "  python3 -m venv .venv"
  echo "  .venv/bin/pip install -r requirements-analysis.txt"
  exit 1
fi

export MPLCONFIGDIR="${MPLCONFIGDIR:-$(pwd)/.matplotlib}"
mkdir -p "$MPLCONFIGDIR"

exec .venv/bin/python scripts.py "$@"
