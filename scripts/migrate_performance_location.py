import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'bandtrack.db')


def migrate(db_path: str | None = None) -> bool:
    """Ensure the performances table has a location column.
    Returns True if a migration was performed."""
    conn = sqlite3.connect(db_path or DB_PATH)
    conn.execute('PRAGMA foreign_keys = ON')
    cur = conn.cursor()
    cur.execute("PRAGMA table_info(performances)")
    columns = [row[1] for row in cur.fetchall()]
    if 'location' not in columns:
        cur.execute('ALTER TABLE performances ADD COLUMN location TEXT')
        cur.execute("UPDATE performances SET location = '' WHERE location IS NULL")
        conn.commit()
        conn.close()
        return True
    conn.close()
    return False


if __name__ == '__main__':
    if migrate():
        print('Added location column to performances.')
    else:
        print('No migration necessary.')
