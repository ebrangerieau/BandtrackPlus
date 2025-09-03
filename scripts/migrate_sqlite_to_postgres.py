"""Migrate data from an existing SQLite database to PostgreSQL.

Usage:
    python scripts/migrate_sqlite_to_postgres.py path/to/sqlite.db

Environment variables for the PostgreSQL destination are the same as
those used by ``server.py`` (``DATABASE_URL`` or ``DB_*`` variables).
"""
import argparse
import sqlite3
import server

TABLES = [
    "users",
    "users_webauthn",
    "groups",
    "memberships",
    "sessions",
    "suggestions",
    "suggestion_votes",
    "rehearsals",
    "partitions",
    "performances",
    "rehearsal_events",
    "settings",
    "logs",
    "notifications",
    "push_subscriptions",
]


def migrate(sqlite_path: str) -> None:
    server.init_db()
    with sqlite3.connect(sqlite_path) as src, server.get_db_connection() as dst:
        src.row_factory = sqlite3.Row
        cur_src = src.cursor()
        cur_dst = dst.cursor()
        for table in TABLES:
            rows = cur_src.execute(f"SELECT * FROM {table}").fetchall()
            if not rows:
                continue
            columns = rows[0].keys()
            col_list = ",".join(columns)
            placeholders = ",".join(["%s"] * len(columns))
            for row in rows:
                values = [row[c] for c in columns]
                cur_dst.execute(
                    f"INSERT INTO {table} ({col_list}) VALUES ({placeholders})",
                    values,
                )
        dst.commit()


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate SQLite data to PostgreSQL")
    parser.add_argument("sqlite_db", help="Path to the existing SQLite database")
    args = parser.parse_args()
    migrate(args.sqlite_db)


if __name__ == "__main__":
    main()
