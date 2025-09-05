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

    changed = False

    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='group_members'")
    group_members_exists = cur.fetchone() is not None
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='memberships'")
    memberships_exists = cur.fetchone() is not None

    if group_members_exists and not memberships_exists:
        cur.execute(
            '''CREATE TABLE memberships (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   user_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   role TEXT NOT NULL DEFAULT 'user',
                   nickname TEXT,
                   joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                   active INTEGER NOT NULL DEFAULT 1,
                   UNIQUE(user_id, group_id)
               );'''
        )
        cur.execute('SELECT user_id, group_id FROM group_members')
        for user_id, group_id in cur.fetchall():
            cur.execute(
                'INSERT INTO memberships (user_id, group_id, role, active) VALUES (?, ?, ?, 1)',
                (user_id, group_id, 'user'),
            )
        cur.execute('DROP TABLE group_members')
        memberships_exists = True
        changed = True

    if memberships_exists:
        cur.execute('PRAGMA table_info(memberships)')
        info = cur.fetchall()
        columns = {row[1]: row for row in info}
        role_default = columns.get('role', [None, None, None, None, None])[4]
        missing = [c for c in ['nickname', 'joined_at', 'active'] if c not in columns]
        if missing or role_default != "'user'":
            cur.execute('ALTER TABLE memberships RENAME TO memberships_old')
            cur.execute(
                '''CREATE TABLE memberships (
                       id INTEGER PRIMARY KEY AUTOINCREMENT,
                       user_id INTEGER NOT NULL,
                       group_id INTEGER NOT NULL,
                       role TEXT NOT NULL DEFAULT 'user',
                       nickname TEXT,
                       joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                       active INTEGER NOT NULL DEFAULT 1,
                       UNIQUE(user_id, group_id)
                   );'''
            )
            cur.execute(
                '''INSERT INTO memberships (id, user_id, group_id, role, nickname, joined_at, active)
                   SELECT id, user_id, group_id,
                          CASE WHEN role IS NULL OR role = 'member' THEN 'user' ELSE role END,
                          nickname,
                          joined_at,
                          COALESCE(active, 1)
                   FROM memberships_old'''
            )
            cur.execute('DROP TABLE memberships_old')
            changed = True
        else:
            cur.execute("UPDATE memberships SET role = 'user' WHERE role IS NULL OR role = 'member'")
        cur.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_group ON memberships(user_id, group_id)')

    # Ensure groups table has new schema columns when it exists
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='groups'")
    if cur.fetchone():
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

    conn.commit()
    conn.close()
    return changed


if __name__ == '__main__':
    if migrate():
        print('Legacy group_members migrated to memberships.')
    else:
        print('No migration necessary.')
