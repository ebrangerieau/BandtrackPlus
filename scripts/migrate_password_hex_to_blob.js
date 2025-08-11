const path = require('path');
const sqlite3 = require('sqlite3').verbose();

const DB_PATH = path.join(__dirname, '..', 'bandtrack.db');

function migrate() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.serialize(() => {
      db.all('PRAGMA table_info(users)', (err, columns) => {
        if (err) {
          db.close();
          return reject(err);
        }
        const hashCol = columns.find((c) => c.name === 'password_hash');
        if (!hashCol) {
          db.close();
          return resolve(false); // No users table
        }
        if (hashCol.type && hashCol.type.toUpperCase() === 'BLOB') {
          db.close();
          return resolve(false); // Already migrated
        }
        db.run('ALTER TABLE users RENAME TO users_old');
        db.run(
          `CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL UNIQUE,
            password_hash BLOB NOT NULL,
            salt BLOB NOT NULL,
            role TEXT NOT NULL DEFAULT 'user'
          );`
        );
        db.all('SELECT id, username, password_hash, salt, role FROM users_old', (selErr, rows) => {
          if (selErr) {
            db.close();
            return reject(selErr);
          }
          const insert = db.prepare(
            'INSERT INTO users (id, username, password_hash, salt, role) VALUES (?, ?, ?, ?, ?)'
          );
          rows.forEach((r) => {
            const hashBuf = Buffer.from(r.password_hash, 'hex');
            const saltBuf = Buffer.from(r.salt, 'hex');
            insert.run(r.id, r.username, hashBuf, saltBuf, r.role);
          });
          insert.finalize((finErr) => {
            if (finErr) {
              db.close();
              return reject(finErr);
            }
            db.run('DROP TABLE users_old', (dropErr) => {
              db.close();
              if (dropErr) reject(dropErr);
              else resolve(true);
            });
          });
        });
      });
    });
  });
}

if (require.main === module) {
  migrate()
    .then((ran) => {
      if (ran) {
        console.log('Migration completed: password hashes stored as blobs.');
      }
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = migrate;
