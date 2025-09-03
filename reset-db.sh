#!/bin/bash
set -euo pipefail

rm -f bandtrack.db
python3 - <<'PY'
from scripts.migrate_to_multigroup import migrate as migrate_to_multigroup
from bandtrack.db import init_db
from scripts.migrate_performance_location import migrate as migrate_performance_location
from scripts.migrate_suggestion_votes import migrate as migrate_suggestion_votes
from scripts.migrate_sessions_group_id import migrate as migrate_sessions_group_id

migrate_to_multigroup()
init_db()
migrate_performance_location()
migrate_suggestion_votes()
migrate_sessions_group_id()
PY
