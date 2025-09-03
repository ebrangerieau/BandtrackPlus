from bandtrack.db import _using_postgres, get_db_connection, execute_write


def migrate() -> bool:
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
