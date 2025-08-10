import os
import sqlite3
import base64

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'bandtrack.db')


def generate_code() -> str:
    return base64.urlsafe_b64encode(os.urandom(4)).decode('ascii').rstrip('=')


def migrate() -> bool:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='groups'")
    if cur.fetchone():
        conn.close()
        return False

    cur.execute(
        '''CREATE TABLE groups (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               invitation_code TEXT NOT NULL UNIQUE,
               description TEXT,
               logo_url TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               owner_id INTEGER NOT NULL
           );'''
    )
    cur.execute(
        '''CREATE TABLE memberships (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id INTEGER NOT NULL,
               group_id INTEGER NOT NULL,
               role TEXT NOT NULL,
               nickname TEXT,
               joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               active INTEGER NOT NULL DEFAULT 1,
               UNIQUE(user_id, group_id)
           );'''
    )
    code = generate_code()
    cur.execute(
        'INSERT INTO groups (id, name, invitation_code, owner_id) VALUES (1, ?, ?, 1)',
        ('Groupe de musique', code),
    )
    for table in ['suggestions', 'rehearsals', 'performances', 'settings']:
        try:
            cur.execute(f'ALTER TABLE {table} ADD COLUMN group_id INTEGER')
            cur.execute(f'UPDATE {table} SET group_id = 1 WHERE group_id IS NULL')
        except sqlite3.OperationalError:
            pass
    cur.execute('SELECT id, role FROM users')
    for uid, role in cur.fetchall():
        cur.execute(
            'INSERT INTO memberships (user_id, group_id, role, active) VALUES (?, 1, ?, 1)',
            (uid, role or 'user'),
        )
    cur.execute(
        "INSERT OR IGNORE INTO settings (group_id, group_name, dark_mode) VALUES (1, 'Groupe de musique', 0)"
    )
    conn.commit()
    conn.close()
    return True


if __name__ == '__main__':
    if migrate():
        print('Migration to multi-group completed.')
    else:
        print('No migration necessary.')
