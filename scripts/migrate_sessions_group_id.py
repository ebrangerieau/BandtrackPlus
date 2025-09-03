import server


def migrate() -> bool:
    if not server._using_postgres():
        return False
    with server.get_db_connection() as conn:
        cur = conn.cursor()
        server.execute_write(
            cur,
            "SELECT column_name FROM information_schema.columns WHERE table_name='sessions' AND column_name='group_id'",
        )
        if cur.fetchone():
            return False
        server.execute_write(cur, 'ALTER TABLE sessions ADD COLUMN group_id INTEGER')
        server.execute_write(cur, 'UPDATE sessions SET group_id = NULL WHERE group_id IS NULL')
    return True


if __name__ == '__main__':
    if migrate():
        print('Added group_id column to sessions table.')
    else:
        print('No migration necessary.')
