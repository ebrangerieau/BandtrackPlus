import sqlite3

from bandtrack.db import _using_postgres, get_db_connection, execute_write


def migrate(db_path: str | None = None) -> bool:
    if db_path and not _using_postgres():
        conn = sqlite3.connect(db_path)
        cur = conn.cursor()
        cur.execute('PRAGMA table_info(sessions)')
        columns = [row[1] for row in cur.fetchall()]
        if 'group_id' in columns:
            conn.close()
            return False
        cur.execute('ALTER TABLE sessions ADD COLUMN group_id INTEGER')
        conn.commit()
        conn.close()
        return True
    if not _using_postgres():
        return False
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(
            cur,
            "SELECT column_name FROM information_schema.columns WHERE table_name='sessions' AND column_name='group_id'",
        )
        if cur.fetchone():
            return False
        execute_write(cur, 'ALTER TABLE sessions ADD COLUMN group_id INTEGER')
        execute_write(cur, 'UPDATE sessions SET group_id = NULL WHERE group_id IS NULL')
    return True


if __name__ == '__main__':
    if migrate():
        print('Added group_id column to sessions table.')
    else:
        print('No migration necessary.')
