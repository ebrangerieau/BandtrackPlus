#!/bin/bash
set -euo pipefail

TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_ROOT="backups"
DEST="$BACKUP_ROOT/$TIMESTAMP"

mkdir -p "$DEST"

cp bandtrack.db "$DEST/"

if [ -d audios ]; then
  cp -r audios "$DEST/"
fi

MAX_BACKUPS=${MAX_BACKUPS:-7}

cd "$BACKUP_ROOT"
ls -1dt */ 2>/dev/null | tail -n +$((MAX_BACKUPS+1)) | xargs -r rm -rf
