const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'bandtrack.db');

function migrate() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.serialize(() => {
      db.run(
        `CREATE TABLE IF NOT EXISTS rehearsal_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          location TEXT,
          group_id INTEGER NOT NULL,
          creator_id INTEGER NOT NULL
        );`,
        (err) => {
          db.close();
          if (err) reject(err);
          else resolve(true);
        }
      );
    });
  });
}

if (require.main === module) {
  migrate()
    .then(() => {
      console.log('Migration completed');
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = migrate;
