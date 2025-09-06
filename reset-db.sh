#!/bin/bash
set -euo pipefail

python3 - <<'PY'
from bandtrack.db import get_db_connection, init_db

with get_db_connection() as conn:
    cur = conn.cursor()
    cur.execute("DROP SCHEMA public CASCADE")
    cur.execute("CREATE SCHEMA public")
init_db()
PY
