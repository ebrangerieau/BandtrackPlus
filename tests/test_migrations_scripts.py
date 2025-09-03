import os
import sys
import sqlite3
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

@pytest.fixture(autouse=True)
def reset_db():  # type: ignore[override]
    # Override the autouse reset_db fixture from conftest to avoid
    # requiring a PostgreSQL container for these unit tests.
    pass

from scripts.migrate_to_multigroup import migrate as migrate_to_multigroup
from scripts.migrate_suggestion_votes import migrate as migrate_suggestion_votes
from scripts.migrate_performance_location import migrate as migrate_performance_location
from scripts.migrate_sessions_group_id import migrate as migrate_sessions_group_id


def test_migrate_to_multigroup_db_path(tmp_path):
    db = tmp_path / "test.db"
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT)")
    cur.execute("INSERT INTO users (username) VALUES ('alice')")
    cur.execute(
        "CREATE TABLE settings (id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER, group_name TEXT, dark_mode INTEGER)"
    )
    conn.commit()
    conn.close()
    assert migrate_to_multigroup(str(db)) is True
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='groups'")
    assert cur.fetchone() is not None
    cur.execute("PRAGMA table_info(users)")
    columns = [row[1] for row in cur.fetchall()]
    assert 'role' in columns
    conn.close()


def test_migrate_suggestion_votes_db_path(tmp_path):
    db = tmp_path / "test.db"
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("CREATE TABLE users (id INTEGER PRIMARY KEY)")
    cur.executemany("INSERT INTO users (id) VALUES (?)", [(1,), (2,)])
    cur.execute("CREATE TABLE suggestions (id INTEGER PRIMARY KEY, likes INTEGER)")
    cur.execute("INSERT INTO suggestions (id, likes) VALUES (1, 2)")
    conn.commit()
    conn.close()
    assert migrate_suggestion_votes(str(db)) is True
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='suggestion_votes'")
    assert cur.fetchone() is not None
    cur.execute("SELECT COUNT(*) FROM suggestion_votes")
    assert cur.fetchone()[0] == 2
    conn.close()


def test_migrate_performance_location_db_path(tmp_path):
    db = tmp_path / "test.db"
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("CREATE TABLE performances (id INTEGER PRIMARY KEY)")
    conn.commit()
    conn.close()
    assert migrate_performance_location(str(db)) is True
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(performances)")
    columns = [row[1] for row in cur.fetchall()]
    assert 'location' in columns
    conn.close()


def test_migrate_sessions_group_id_db_path(tmp_path):
    db = tmp_path / "test.db"
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("CREATE TABLE sessions (id INTEGER PRIMARY KEY, token TEXT)")
    conn.commit()
    conn.close()
    assert migrate_sessions_group_id(str(db)) is True
    conn = sqlite3.connect(db)
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(sessions)")
    columns = [row[1] for row in cur.fetchall()]
    assert 'group_id' in columns
    conn.close()
