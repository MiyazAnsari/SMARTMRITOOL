#!/usr/bin/env bash
# Copy the local analysis notebook (and optional .py mirror) into the shared
# Google Drive project folder. Drive for Desktop then uploads it automatically.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
SRC_IPYNB="$REPO_ROOT/scripts_v4.ipynb"
SRC_PY="$REPO_ROOT/scripts.py"

# Resolve Drive project folder the same way the analysis script does
DRIVE_PROJECT=""
if [[ -n "${LOCAL_PROJECT_PATH:-}" && -d "${LOCAL_PROJECT_PATH}/csv exports" ]]; then
  DRIVE_PROJECT="$LOCAL_PROJECT_PATH"
else
  shopt -s nullglob
  for d in "$HOME/Library/CloudStorage"/GoogleDrive-*/"My Drive"/"Current Knee MRI Project Folder"; do
    if [[ -d "$d/csv exports" ]]; then
      DRIVE_PROJECT="$d"
      break
    fi
  done
  shopt -u nullglob
fi

if [[ -z "$DRIVE_PROJECT" ]]; then
  echo "Could not find shared Drive folder 'Current Knee MRI Project Folder'."
  echo "Is Google Drive for Desktop signed in? Or set LOCAL_PROJECT_PATH."
  exit 1
fi

DEST_DIR="$DRIVE_PROJECT/scripts"
mkdir -p "$DEST_DIR"

if [[ ! -f "$SRC_IPYNB" ]]; then
  echo "Missing $SRC_IPYNB"
  exit 1
fi

cp -f "$SRC_IPYNB" "$DEST_DIR/scripts_v4.ipynb"
echo "Updated: $DEST_DIR/scripts_v4.ipynb"

if [[ -f "$SRC_PY" ]]; then
  cp -f "$SRC_PY" "$DEST_DIR/scripts_v4.py"
  echo "Updated: $DEST_DIR/scripts_v4.py"
fi

echo
echo "Google Drive for Desktop will upload these shortly."
echo "In Colab: open the Drive copy (or File → Upload if you prefer a one-off)."
