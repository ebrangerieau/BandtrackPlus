import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'bandtrack.db')


def migrate() -> bool:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    # Ensure suggestion_votes table exists
    cur.execute(
        """CREATE TABLE IF NOT EXISTS suggestion_votes (
               suggestion_id INTEGER NOT NULL,
               user_id INTEGER NOT NULL,
               PRIMARY KEY (suggestion_id, user_id),
               FOREIGN KEY (suggestion_id) REFERENCES suggestions(id),
               FOREIGN KEY (user_id) REFERENCES users(id)
           );"""
    )
    cur.execute('SELECT COUNT(*) FROM suggestion_votes')
    if cur.fetchone()[0] > 0:
        conn.close()
        return False
    # Fetch all users
    cur.execute('SELECT id FROM users')
    users = [row[0] for row in cur.fetchall()]
    if not users:
        conn.close()
        return False
    cur.execute('SELECT id, likes FROM suggestions')
    suggestions = cur.fetchall()
    for sug_id, likes in suggestions:
        for uid in users[:likes]:
            cur.execute(
                'INSERT OR IGNORE INTO suggestion_votes (suggestion_id, user_id) VALUES (?, ?)',
                (sug_id, uid),
            )
        cur.execute('UPDATE suggestions SET likes = ? WHERE id = ?', (min(likes, len(users)), sug_id))
    conn.commit()
    conn.close()
    return True


if __name__ == '__main__':
    if migrate():
        print('Migration of suggestion votes completed.')
    else:
        print('No migration necessary.')
