#!/bin/bash
set -euo pipefail

rm -f bandtrack.db
python3 - <<'PY'
import server
server.migrate_to_multigroup()
server.init_db()
server.migrate_performance_location()
server.migrate_suggestion_votes()
PY
