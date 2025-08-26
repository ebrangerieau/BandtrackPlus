import os
import sqlite3
import base64

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'bandtrack.db')


def generate_code() -> str:
    return base64.urlsafe_b64encode(os.urandom(4)).decode('ascii').rstrip('=')


def migrate() -> bool:
    conn = sqlite3.connect(DB_PATH)
    conn.execute('PRAGMA foreign_keys = OFF')
    cur = conn.cursor()

    # Skip when no legacy table is present or migration already applied
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='group_members'")
    if not cur.fetchone():
        conn.close()
        return False
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='memberships'")
    if cur.fetchone():
        conn.close()
        return False

    # Create new memberships table and copy data from legacy group_members
    cur.execute(
        '''CREATE TABLE memberships (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id INTEGER NOT NULL,
               group_id INTEGER NOT NULL,
               role TEXT NOT NULL DEFAULT 'member',
               nickname TEXT,
               joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               active INTEGER NOT NULL DEFAULT 1,
               UNIQUE(user_id, group_id)
           );'''
    )
    cur.execute('SELECT user_id, group_id FROM group_members')
    rows = cur.fetchall()
    for user_id, group_id in rows:
        cur.execute(
            'INSERT INTO memberships (user_id, group_id, role, active) VALUES (?, ?, ?, 1)',
            (user_id, group_id, 'member'),
        )
    cur.execute('DROP TABLE group_members')

    # Ensure groups table has new schema columns
    cur.execute('PRAGMA table_info(groups)')
    columns = [row[1] for row in cur.fetchall()]
    if 'invitation_code' not in columns:
        cur.execute('ALTER TABLE groups ADD COLUMN invitation_code TEXT')
    if 'description' not in columns:
        cur.execute('ALTER TABLE groups ADD COLUMN description TEXT')
    if 'logo_url' not in columns:
        cur.execute('ALTER TABLE groups ADD COLUMN logo_url TEXT')
    if 'created_at' not in columns:
        cur.execute('ALTER TABLE groups ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP')
    if 'owner_id' not in columns:
        cur.execute('ALTER TABLE groups ADD COLUMN owner_id INTEGER')

    cur.execute('SELECT id, invitation_code, owner_id FROM groups')
    for gid, code, owner in cur.fetchall():
        if not code:
            cur.execute('UPDATE groups SET invitation_code = ? WHERE id = ?', (generate_code(), gid))
        if owner is None:
            cur.execute('UPDATE groups SET owner_id = 1 WHERE id = ?', (gid,))

    cur.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_group ON memberships(user_id, group_id)')

    conn.commit()
    conn.close()
    return True


if __name__ == '__main__':
    if migrate():
        print('Legacy group_members migrated to memberships.')
    else:
        print('No migration necessary.')
