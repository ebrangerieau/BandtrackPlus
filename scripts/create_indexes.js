const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'bandtrack.db');

function createIndexes() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) {
        reject(err);
      } else {
        db.serialize(() => {
          db.run(
            'CREATE INDEX IF NOT EXISTS idx_suggestions_group_likes_created_at ON suggestions (group_id, likes, created_at)',
            (e) => e && console.warn('suggestions index skipped:', e.message)
          );
          db.run(
            'CREATE INDEX IF NOT EXISTS idx_rehearsals_group_created_at ON rehearsals (group_id, created_at)',
            (e) => e && console.warn('rehearsals index skipped:', e.message)
          );
          db.run(
            'CREATE INDEX IF NOT EXISTS idx_memberships_user_group ON memberships (user_id, group_id)',
            (e) => e && console.warn('memberships index skipped:', e.message)
          );
          db.close((closeErr) => {
            if (closeErr) reject(closeErr);
            else resolve();
          });
        });
      }
    });
  });
}

if (require.main === module) {
  createIndexes()
    .then(() => {
      console.log('Indexes created or already exist.');
    })
    .catch((err) => {
      console.error('Failed to create indexes:', err);
      process.exit(1);
    });
}

module.exports = createIndexes;
