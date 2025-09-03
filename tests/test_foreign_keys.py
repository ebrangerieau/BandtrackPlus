import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import psycopg2
import pytest
import bandtrack.api as server


def test_membership_foreign_key_enforced(tmp_path):
    server.init_db()

    with server.get_db_connection() as conn:
        cur = conn.cursor()
        server.execute_write(
            cur,
            "INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)",
            ("owner", b"s", b"h"),
        )
        owner_id = cur.lastrowid
        server.execute_write(
            cur,
            "INSERT INTO groups (name, invitation_code, owner_id) VALUES (?, ?, ?)",
            ("g", "code", owner_id),
        )
        group_id = cur.lastrowid

    with server.get_db_connection() as conn:
        cur = conn.cursor()
        with pytest.raises(psycopg2.IntegrityError):
            server.execute_write(
                cur,
                "INSERT INTO memberships (user_id, group_id, role) VALUES (?, ?, ?)",
                (999, group_id, "member"),
            )


def test_partition_cascade_on_rehearsal_delete(tmp_path):
    server.init_db()

    with server.get_db_connection() as conn:
        cur = conn.cursor()
        server.execute_write(
            cur,
            "INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)",
            ("u", b"s", b"h"),
        )
        user_id = cur.lastrowid
        server.execute_write(
            cur,
            "INSERT INTO groups (name, invitation_code, owner_id) VALUES (?, ?, ?)",
            ("g", "code", user_id),
        )
        group_id = cur.lastrowid
        server.execute_write(
            cur,
            "INSERT INTO rehearsals (title, creator_id, group_id) VALUES (?, ?, ?)",
            ("song", user_id, group_id),
        )
        reh_id = cur.lastrowid
        server.execute_write(
            cur,
            "INSERT INTO partitions (rehearsal_id, path, display_name, uploader_id) VALUES (?, ?, ?, ?)",
            (reh_id, "/tmp/file.pdf", "file.pdf", user_id),
        )
        server.execute_write(cur, "DELETE FROM rehearsals WHERE id = ?", (reh_id,))
        server.execute_write(cur, "SELECT COUNT(*) FROM partitions WHERE rehearsal_id = ?", (reh_id,))
        count = cur.fetchone()[0]
    assert count == 0
