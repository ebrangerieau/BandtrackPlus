import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import sqlite3
import pytest
import server


def test_membership_foreign_key_enforced(tmp_path):
    db_path = tmp_path / "test.db"
    server.DB_FILENAME = str(db_path)
    server.init_db()

    conn = server.get_db_connection()
    cur = conn.cursor()
    cur.execute(
        "INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)",
        ("owner", b"s", b"h"),
    )
    owner_id = cur.lastrowid
    cur.execute(
        "INSERT INTO groups (name, invitation_code, owner_id) VALUES (?, ?, ?)",
        ("g", "code", owner_id),
    )
    group_id = cur.lastrowid
    conn.commit()
    conn.close()

    conn = server.get_db_connection()
    cur = conn.cursor()
    with pytest.raises(sqlite3.IntegrityError):
        cur.execute(
            "INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, ?)",
            (999, group_id, "member"),
        )
        conn.commit()
    conn.close()
