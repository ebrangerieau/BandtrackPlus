import os
import json
import sqlite3

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'bandtrack.db')


def migrate():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute('SELECT id, audio_notes_json FROM rehearsals')
    rows = cur.fetchall()
    updated = 0
    for rid, json_data in rows:
        try:
            notes = json.loads(json_data or '{}')
        except Exception:
            notes = {}
        changed = False
        for user, val in list(notes.items()):
            if isinstance(val, list):
                continue
            notes[user] = [{'title': '', 'data': val}] if val else []
            changed = True
        if changed:
            cur.execute('UPDATE rehearsals SET audio_notes_json = ? WHERE id = ?', (json.dumps(notes), rid))
            updated += 1
    conn.commit()
    conn.close()
    return updated


if __name__ == '__main__':
    count = migrate()
    if count:
        print(f'Migration completed: converted {count} rows.')
