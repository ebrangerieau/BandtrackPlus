const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'bandtrack.db');

function migrate() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.serialize(() => {
      db.all('SELECT id, audio_notes_json FROM rehearsals', (err, rows) => {
        if (err) {
          db.close();
          return reject(err);
        }
        let updated = 0;
        const stmt = db.prepare('UPDATE rehearsals SET audio_notes_json = ? WHERE id = ?');
        rows.forEach((row) => {
          let notes;
          try {
            notes = JSON.parse(row.audio_notes_json || '{}');
          } catch {
            notes = {};
          }
          let changed = false;
          for (const user of Object.keys(notes)) {
            const val = notes[user];
            if (Array.isArray(val)) continue;
            notes[user] = val ? [{ title: '', data: val }] : [];
            changed = true;
          }
          if (changed) {
            stmt.run(JSON.stringify(notes), row.id);
            updated++;
          }
        });
        stmt.finalize((err2) => {
          db.close();
          if (err2) reject(err2);
          else resolve(updated);
        });
      });
    });
  });
}

if (require.main === module) {
  migrate()
    .then((count) => {
      if (count) {
        console.log(`Migration completed: converted ${count} rows.`);
      }
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = migrate;
