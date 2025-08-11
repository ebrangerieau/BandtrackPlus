const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, '..', 'bandtrack.db');

function generateCode() {
  return crypto.randomBytes(4).toString('base64url');
}

function addGroupId(db, table) {
  db.run(`ALTER TABLE ${table} ADD COLUMN group_id INTEGER`, () => {
    db.run(`UPDATE ${table} SET group_id = 1 WHERE group_id IS NULL`);
  });
}

function migrate() {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.get(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='groups'",
      (err, row) => {
        if (err) {
          db.close();
          return reject(err);
        }
        if (row) {
          db.close();
          return resolve(false); // already migrated
        }
        db.serialize(() => {
          db.run(
            `CREATE TABLE groups (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              invitation_code TEXT NOT NULL UNIQUE,
              description TEXT,
              logo_url TEXT,
              created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              owner_id INTEGER NOT NULL
            );`
          );
          db.run(
            `CREATE TABLE memberships (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              user_id INTEGER NOT NULL,
              group_id INTEGER NOT NULL,
              role TEXT NOT NULL,
              nickname TEXT,
              joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
              active INTEGER NOT NULL DEFAULT 1,
              UNIQUE(user_id, group_id)
            );`
          );
          const code = generateCode();
          db.run(
            'INSERT INTO groups (id, name, invitation_code, owner_id) VALUES (1, ?, ?, 1)',
            ['Groupe de musique', code]
          );
          ['suggestions', 'rehearsals', 'performances', 'settings'].forEach((t) =>
            addGroupId(db, t)
          );
          db.all('PRAGMA table_info(users)', (pErr, columns) => {
            if (pErr) {
              db.close();
              return reject(pErr);
            }
            const hasRole = columns.some((c) => c.name === 'role');
            const proceed = () => {
              db.all('SELECT id, role FROM users', (uErr, users) => {
                if (uErr) {
                  db.close();
                  return reject(uErr);
                }
                const stmt = db.prepare(
                  'INSERT INTO memberships (user_id, group_id, role, active) VALUES (?, 1, ?, 1)'
                );
                users.forEach((u) => stmt.run(u.id, u.role || 'user'));
                stmt.finalize((fErr) => {
                  if (fErr) {
                    db.close();
                    return reject(fErr);
                  }
                  db.run(
                    "INSERT OR IGNORE INTO settings (group_id, group_name, dark_mode) VALUES (1, 'Groupe de musique', 0)",
                    (sErr) => {
                      db.close();
                      if (sErr) return reject(sErr);
                      resolve(true);
                    }
                  );
                });
              });
            };
            if (!hasRole) {
              db.run(
                "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'",
                (aErr) => {
                  if (aErr) {
                    db.close();
                    return reject(aErr);
                  }
                  proceed();
                }
              );
            } else {
              proceed();
            }
          });
        });
      }
    );
  });
}

if (require.main === module) {
  migrate()
    .then((ran) => {
      if (ran) {
        console.log('Migration to multi-group completed.');
      }
    })
    .catch((err) => {
      console.error('Migration failed:', err);
      process.exit(1);
    });
}

module.exports = migrate;
