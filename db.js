const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');

// Database file path relative to this module.  We keep the database
// in the project root so it persists across server restarts.
const DB_PATH = path.join(__dirname, 'bandtrack.db');

// Open a connection to SQLite.  The database will be created if it
// doesn’t already exist.  We use `serialize` to ensure queries are
// executed sequentially.
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Could not connect to database', err);
  } else {
    console.log('Connected to SQLite database');
  }
});

/**
 * Initializes the database by creating the necessary tables if they do not
 * already exist.  This function is idempotent and safe to call on every
 * server startup.
 */
function init() {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      let pending = 0;

      const originalRun = db.run.bind(db);
      const originalAll = db.all.bind(db);
      const originalGet = db.get.bind(db);

      const checkDone = () => {
        if (pending === 0) {
          db.run = originalRun;
          db.all = originalAll;
          db.get = originalGet;
          resolve();
        }
      };

      db.run = function (sql, params, cb) {
        if (typeof params === 'function') {
          cb = params;
          params = [];
        }
        pending++;
        return originalRun.call(db, sql, params, function (err) {
          if (cb) cb(err);
          if (err) reject(err);
          pending--;
          checkDone();
        });
      };

      db.all = function (sql, params, cb) {
        if (typeof params === 'function') {
          cb = params;
          params = [];
        }
        pending++;
        return originalAll.call(db, sql, params, function (err, rows) {
          if (cb) cb(err, rows);
          if (err) reject(err);
          pending--;
          checkDone();
        });
      };

      db.get = function (sql, params, cb) {
        if (typeof params === 'function') {
          cb = params;
          params = [];
        }
        pending++;
        return originalGet.call(db, sql, params, function (err, row) {
          if (cb) cb(err, row);
          if (err) reject(err);
          pending--;
          checkDone();
        });
      };

      // Users: store a unique username, a password hash and its salt.
      db.run(
        `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user'
        );`
      );

      // Ensure salt and role columns exist on existing databases
      db.all('PRAGMA table_info(users)', (err, rows) => {
        if (!err && rows) {
          if (!rows.find((r) => r.name === 'salt')) {
            db.run('ALTER TABLE users ADD COLUMN salt TEXT');
          }
          if (!rows.find((r) => r.name === 'role')) {
            db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
          }
        }
      });

      // WebAuthn credentials associated with users
      db.run(
        `CREATE TABLE IF NOT EXISTS users_webauthn (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          credential_id TEXT NOT NULL UNIQUE,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );`
      );

      // Suggestions table
      db.run(
        `CREATE TABLE IF NOT EXISTS suggestions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          author TEXT,
          url TEXT,
          youtube TEXT,
          likes INTEGER NOT NULL DEFAULT 0,
          creator_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (creator_id) REFERENCES users(id),
          FOREIGN KEY (group_id) REFERENCES groups(id)
        );`
      );

      // Votes per user on suggestions
      db.run(
        `CREATE TABLE IF NOT EXISTS suggestion_votes (
          suggestion_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          count INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (suggestion_id, user_id),
          FOREIGN KEY (suggestion_id) REFERENCES suggestions(id),
          FOREIGN KEY (user_id) REFERENCES users(id)
        );`
      );

      // Ensure new columns exist before creating index
      db.all('PRAGMA table_info(suggestions)', (err, rows) => {
        if (!err && rows) {
          if (!rows.find((r) => r.name === 'likes')) {
            db.run('ALTER TABLE suggestions ADD COLUMN likes INTEGER NOT NULL DEFAULT 0');
          }
          if (!rows.find((r) => r.name === 'author')) {
            db.run('ALTER TABLE suggestions ADD COLUMN author TEXT');
          }
          if (!rows.find((r) => r.name === 'youtube')) {
            db.run('ALTER TABLE suggestions ADD COLUMN youtube TEXT');
          }
          if (!rows.find((r) => r.name === 'group_id')) {
            db.run('ALTER TABLE suggestions ADD COLUMN group_id INTEGER');
            db.run(
              'UPDATE suggestions SET group_id = (SELECT group_id FROM memberships m WHERE m.user_id = creator_id AND m.active = 1 ORDER BY m.group_id LIMIT 1) WHERE group_id IS NULL'
            );
          }
          db.run(
            'CREATE INDEX IF NOT EXISTS idx_suggestions_group_likes_created_at ON suggestions (group_id, likes, created_at)'
          );
        }
      });

      // Rehearsals table
      db.run(
        `CREATE TABLE IF NOT EXISTS rehearsals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL,
          youtube TEXT,
          spotify TEXT,
          levels_json TEXT DEFAULT '{}',
          notes_json TEXT DEFAULT '{}',
          audio_notes_json TEXT DEFAULT '{}',
          mastered INTEGER NOT NULL DEFAULT 0,
          creator_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (creator_id) REFERENCES users(id),
          FOREIGN KEY (group_id) REFERENCES groups(id)
        );`
      );

      db.all('PRAGMA table_info(rehearsals)', (err, rows) => {
        if (!err && rows) {
          if (!rows.find((r) => r.name === 'mastered')) {
            db.run('ALTER TABLE rehearsals ADD COLUMN mastered INTEGER NOT NULL DEFAULT 0');
          }
          if (!rows.find((r) => r.name === 'audio_notes_json')) {
            db.run("ALTER TABLE rehearsals ADD COLUMN audio_notes_json TEXT DEFAULT '{}'");
          }
          if (!rows.find((r) => r.name === 'group_id')) {
            db.run('ALTER TABLE rehearsals ADD COLUMN group_id INTEGER');
            db.run(
              'UPDATE rehearsals SET group_id = (SELECT group_id FROM memberships m WHERE m.user_id = creator_id AND m.active = 1 ORDER BY m.group_id LIMIT 1) WHERE group_id IS NULL'
            );
          }
        }
      });

      db.run(
        'CREATE INDEX IF NOT EXISTS idx_rehearsals_group_created_at ON rehearsals (group_id, created_at)'
      );

      // Performances table
      db.run(
        `CREATE TABLE IF NOT EXISTS performances (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          date TEXT NOT NULL,
          location TEXT,
          songs_json TEXT DEFAULT '[]',
          creator_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (creator_id) REFERENCES users(id),
          FOREIGN KEY (group_id) REFERENCES groups(id)
        );`
      );

      db.all('PRAGMA table_info(performances)', (err, rows) => {
        if (!err && rows) {
          if (!rows.find((r) => r.name === 'location')) {
            db.run('ALTER TABLE performances ADD COLUMN location TEXT');
          }
          if (!rows.find((r) => r.name === 'group_id')) {
            db.run('ALTER TABLE performances ADD COLUMN group_id INTEGER');
            db.run(
              'UPDATE performances SET group_id = (SELECT group_id FROM memberships m WHERE m.user_id = creator_id AND m.active = 1 ORDER BY m.group_id LIMIT 1) WHERE group_id IS NULL'
            );
          }
        }
      });

      // Settings table
      db.run(
        `CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          group_id INTEGER NOT NULL UNIQUE,
          group_name TEXT NOT NULL,
          dark_mode INTEGER NOT NULL DEFAULT 0,
          template TEXT NOT NULL DEFAULT 'classic',
          next_rehearsal_date TEXT,
          next_rehearsal_location TEXT,
          FOREIGN KEY (group_id) REFERENCES groups(id)
        );`,
        () => {
          db.get('SELECT COUNT(*) AS count FROM settings', (err, row) => {
            if (!err && row && row.count === 0) {
              db.run(
                "INSERT INTO settings (group_id, group_name, dark_mode, template, next_rehearsal_date, next_rehearsal_location) VALUES (1, ?, 0, 'classic', '', '')",
                ['Groupe de musique']
              );
            }
          });
        }
      );

      db.all('PRAGMA table_info(settings)', (err, rows) => {
        if (!err && rows) {
          if (!rows.find((r) => r.name === 'next_rehearsal_date')) {
            db.run('ALTER TABLE settings ADD COLUMN next_rehearsal_date TEXT');
          }
          if (!rows.find((r) => r.name === 'next_rehearsal_location')) {
            db.run('ALTER TABLE settings ADD COLUMN next_rehearsal_location TEXT');
          }
          if (!rows.find((r) => r.name === 'group_id')) {
            db.run('ALTER TABLE settings ADD COLUMN group_id INTEGER');
            db.run('UPDATE settings SET group_id = 1 WHERE group_id IS NULL');
          }
          if (!rows.find((r) => r.name === 'template')) {
            db.run("ALTER TABLE settings ADD COLUMN template TEXT NOT NULL DEFAULT 'classic'");
          }
        }
      });

      // Groups and memberships
      db.run(
        `CREATE TABLE IF NOT EXISTS groups (
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
        `CREATE TABLE IF NOT EXISTS memberships (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          group_id INTEGER NOT NULL,
          role TEXT NOT NULL,
          nickname TEXT,
          joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          active INTEGER NOT NULL DEFAULT 1,
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (group_id) REFERENCES groups(id),
          UNIQUE(user_id, group_id)
        );`
      );

      db.run(
        'CREATE INDEX IF NOT EXISTS idx_memberships_user_group ON memberships (user_id, group_id)'
      );

      // Ensure a default group exists
      pending++;
      generateInvitationCode()
        .then((defaultCode) => {
          db.run(
            'INSERT OR IGNORE INTO groups (id, name, invitation_code, owner_id) VALUES (1, ?, ?, 1)',
            ['Groupe de musique', defaultCode]
          );
          pending--;
          checkDone();
        })
        .catch((err) => reject(err));

      // Logs table
      db.run(
        `CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
          user_id INTEGER,
          action TEXT NOT NULL,
          metadata TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );`
      );

      checkDone();
    });
  });
}

function generateCode() {
  return crypto.randomBytes(4).toString('base64url');
}

function generateInvitationCode() {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const code = generateCode();
      db.get(
        'SELECT 1 FROM groups WHERE invitation_code = ?',
        [code],
        (err, row) => {
          if (err) return reject(err);
          if (row) return attempt();
          resolve(code);
        }
      );
    };
    attempt();
  });
}

/**
 * Creates a new user with the given username, hashed password and salt.
 * Returns a promise that resolves to the inserted user ID.
 * @param {string} username
 * @param {string} passwordHash
 * @param {string} salt
 */
function createUser(username, passwordHash, salt, role = 'user') {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(
      'INSERT INTO users (username, password_hash, salt, role) VALUES (?, ?, ?, ?)',
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
    stmt.run(username, passwordHash, salt, role);
  });
}

/**
 * Returns the total number of users in the database.
 */
function getUserCount() {
  return new Promise((resolve, reject) => {
    db.get('SELECT COUNT(*) as count FROM users', (err, row) => {
      if (err) reject(err);
      else resolve(row.count);
    });
  });
}

/**
 * Retrieves a user by their username.  Returns a promise resolving to the
 * user row or undefined if not found.
 * @param {string} username
 */
function getUserByUsername(username) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, username, password_hash, salt, role FROM users WHERE username = ?',
      [username],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

/**
 * Retrieves a user by ID. Returns id, username and role.
 */
function getUserById(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, username, role FROM users WHERE id = ?',
      [id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

/**
 * Adds a user to a group. Useful for initial registration where every user
 * is placed into the default group.
 */
function addUserToGroup(userId, groupId, role = 'user') {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO memberships (user_id, group_id, role, active) VALUES (?, ?, ?, 1)',
      [userId, groupId, role],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/**
 * Returns the first group id associated with a user.
 */
function getFirstGroupForUser(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT group_id FROM memberships WHERE user_id = ? AND active = 1 ORDER BY group_id LIMIT 1',
      [userId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.group_id : null);
      }
    );
  });
}

/**
 * Checks whether a user belongs to a given group.
 */
function userHasGroup(userId, groupId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ? AND active = 1',
      [userId, groupId],
      (err, row) => {
        if (err) reject(err);
        else resolve(!!row);
      }
    );
  });
}

/**
 * Retrieves a group by its id.
 */
function getGroupById(groupId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT id, name FROM groups WHERE id = ?', [groupId], (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

/**
 * Stores a WebAuthn credential for a user.
 */
function addWebAuthnCredential(userId, credentialId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO users_webauthn (user_id, credential_id) VALUES (?, ?)',
      [userId, credentialId],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Returns all WebAuthn credentials for a user.
 */
function getWebAuthnCredentials(userId) {
  return new Promise((resolve, reject) => {
    db.all('SELECT credential_id FROM users_webauthn WHERE user_id = ?', [userId], (err, rows) => {
      if (err) reject(err);
      else resolve(rows || []);
    });
  });
}

/**
 * Retrieves a WebAuthn credential by its id.
 */
function getWebAuthnCredentialById(credentialId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT user_id, credential_id FROM users_webauthn WHERE credential_id = ?',
      [credentialId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

/**
 * Retrieves all users with their roles.
 */
function getUsers() {
  return new Promise((resolve, reject) => {
    db.all('SELECT id, username, role FROM users ORDER BY username ASC', (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

/**
 * Updates the role of a user identified by id. Resolves with the number of
 * affected rows (0 or 1).
 */
function updateUserRole(id, role) {
  return new Promise((resolve, reject) => {
    db.run('UPDATE users SET role = ? WHERE id = ?', [role, id], function (err) {
      if (err) return reject(err);
      db.run('UPDATE memberships SET role = ? WHERE user_id = ?', [role, id], function (err2) {
        if (err2) reject(err2);
        else resolve(this.changes);
      });
    });
  });
}

/**
 * Creates a new suggestion.
 */
function createSuggestion(title, author, youtube, creatorId, groupId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO suggestions (title, author, youtube, creator_id, group_id) VALUES (?, ?, ?, ?, ?)',
      [title, author, youtube, creatorId, groupId],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Returns all suggestions with creator username.
 */
function getSuggestions(groupId, limit = 100, offset = 0) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT s.id, s.title, s.author, s.url, s.youtube, s.likes, s.creator_id, s.created_at, u.username AS creator
       FROM suggestions s
       JOIN users u ON u.id = s.creator_id
       WHERE s.group_id = ?
       ORDER BY s.likes DESC, s.created_at ASC
       LIMIT ? OFFSET ?`,
      [groupId, limit, offset],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Retrieves a single suggestion by ID within a group.
 */
function getSuggestionById(id, groupId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT s.id, s.title, s.author, s.url, s.youtube, s.likes, s.creator_id, s.created_at, u.username AS creator
       FROM suggestions s
       JOIN users u ON u.id = s.creator_id
       WHERE s.id = ? AND s.group_id = ?`,
      [id, groupId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
  });
}

/**
 * Deletes a suggestion if the given user is the creator.  Returns the number
 * of rows deleted.
 */
function deleteSuggestion(id, userId, role, groupId) {
  return new Promise((resolve, reject) => {
    const sql = role === 'admin' || role === 'moderator'
      ? 'DELETE FROM suggestions WHERE id = ? AND group_id = ?'
      : 'DELETE FROM suggestions WHERE id = ? AND creator_id = ? AND group_id = ?';
    const params = role === 'admin' || role === 'moderator' ? [id, groupId] : [id, userId, groupId];
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Updates a suggestion title and URL if the user is the creator.
 * Resolves with the number of updated rows (0 or 1).
 */
function updateSuggestion(id, title, author, youtube, userId, role, groupId) {
  return new Promise((resolve, reject) => {
    const sql = role === 'admin' || role === 'moderator'
      ? 'UPDATE suggestions SET title = ?, author = ?, youtube = ? WHERE id = ? AND group_id = ?'
      : 'UPDATE suggestions SET title = ?, author = ?, youtube = ? WHERE id = ? AND creator_id = ? AND group_id = ?';
    const params = role === 'admin' || role === 'moderator'
      ? [title, author, youtube, id, groupId]
      : [title, author, youtube, id, userId, groupId];
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Increments the like counter for a suggestion.  Resolves to true if a row was
 * updated.
 */
// --------------------------- Suggestion Likes ---------------------------

/**
 * Increments like counters for a suggestion by a specific user.
 * Both the global like count and the user's vote record are updated.
 * Resolves to true if the suggestion exists.
 */
function incrementUserSuggestionLikes(suggestionId, userId) {
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      db.run(
        'UPDATE suggestions SET likes = likes + 1 WHERE id = ?',
        [suggestionId],
        function (err) {
          if (err) return reject(err);
          if (this.changes === 0) return resolve(false);
          db.run(
            `INSERT INTO suggestion_votes (suggestion_id, user_id, count)
             VALUES (?, ?, 1)
             ON CONFLICT(suggestion_id, user_id)
             DO UPDATE SET count = count + 1`,
            [suggestionId, userId],
            function (err2) {
              if (err2) reject(err2);
              else resolve(true);
            }
          );
        }
      );
    });
  });
}

/**
 * Decrements like counters for a suggestion by the user if they previously
 * voted.  Returns true if a like was removed.
 */
function decrementUserSuggestionLikes(suggestionId, userId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT count FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
      [suggestionId, userId],
      (err, row) => {
        if (err) return reject(err);
        if (!row || row.count <= 0) return resolve(false);
        db.serialize(() => {
          db.run(
            'UPDATE suggestions SET likes = likes - 1 WHERE id = ?',
            [suggestionId]
          );
          db.run(
            'UPDATE suggestion_votes SET count = count - 1 WHERE suggestion_id = ? AND user_id = ?',
            [suggestionId, userId],
            function (err2) {
              if (err2) reject(err2);
              else resolve(true);
            }
          );
        });
      }
    );
  });
}

/**
 * Retrieves the number of likes a given user added to a suggestion.
 */
function getUserSuggestionLikes(suggestionId, userId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT count FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
      [suggestionId, userId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row ? row.count : 0);
      }
    );
  });
}

/**
 * Backwards compatibility helper. Delegates to incrementUserSuggestionLikes.
 */
function incrementSuggestionLikes(id, userId) {
  return incrementUserSuggestionLikes(id, userId);
}

/**
 * Creates a rehearsal.  The levels and notes JSON are initially empty.
 */
function createRehearsal(title, youtube, spotify, creatorId, groupId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO rehearsals (title, youtube, spotify, levels_json, notes_json, audio_notes_json, mastered, creator_id, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [title, youtube || null, spotify || null, '{}', '{}', '{}', 0, creatorId, groupId],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Returns all rehearsals.  Parses JSON fields into objects.
 */
function getRehearsals(groupId, limit = 100, offset = 0) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT r.id, r.title, r.youtube, r.spotify, r.levels_json, r.notes_json, r.audio_notes_json, r.mastered, r.creator_id, r.created_at,
              u.username AS creator
       FROM rehearsals r
       JOIN users u ON u.id = r.creator_id
       WHERE r.group_id = ?
       ORDER BY r.created_at ASC
       LIMIT ? OFFSET ?`,
      [groupId, limit, offset],
      (err, rows) => {
        if (err) {
          reject(err);
        } else {
          const result = rows.map((row) => {
            return {
              id: row.id,
              title: row.title,
              youtube: row.youtube,
              spotify: row.spotify,
              levels: JSON.parse(row.levels_json || '{}'),
              notes: JSON.parse(row.notes_json || '{}'),
              audioNotes: JSON.parse(row.audio_notes_json || '{}'),
              mastered: !!row.mastered,
              creatorId: row.creator_id,
              creator: row.creator,
            };
          });
          resolve(result);
        }
      }
    );
  });
}

/**
 * Retrieves a single rehearsal by ID within a group.
 */
function getRehearsalById(id, groupId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT r.id, r.title, r.youtube, r.spotify, r.levels_json, r.notes_json, r.audio_notes_json, r.mastered, r.creator_id, r.created_at,
              u.username AS creator
       FROM rehearsals r
       JOIN users u ON u.id = r.creator_id
       WHERE r.id = ? AND r.group_id = ?`,
      [id, groupId],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve({
          id: row.id,
          title: row.title,
          youtube: row.youtube,
          spotify: row.spotify,
          levels: JSON.parse(row.levels_json || '{}'),
          notes: JSON.parse(row.notes_json || '{}'),
          audioNotes: JSON.parse(row.audio_notes_json || '{}'),
          mastered: !!row.mastered,
          creatorId: row.creator_id,
          creator: row.creator,
        });
      }
    );
  });
}

/**
 * Updates the level and note for the given rehearsal and user.  Only the
 * current user's values are changed.  Returns a promise.
 */
function updateRehearsalUserData(id, username, level, note, audio) {
  return new Promise((resolve, reject) => {
    // Retrieve existing levels and notes
    db.get(
      'SELECT levels_json, notes_json, audio_notes_json FROM rehearsals WHERE id = ?',
      [id],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Rehearsal not found'));
        const levels = JSON.parse(row.levels_json || '{}');
        const notes = JSON.parse(row.notes_json || '{}');
        const audioNotes = JSON.parse(row.audio_notes_json || '{}');
        if (level !== undefined) {
          levels[username] = level;
        }
        if (note !== undefined) {
          notes[username] = note;
        }
        if (audio !== undefined) {
          audioNotes[username] = audio;
        }
        db.run(
          'UPDATE rehearsals SET levels_json = ?, notes_json = ?, audio_notes_json = ? WHERE id = ?',
          [JSON.stringify(levels), JSON.stringify(notes), JSON.stringify(audioNotes), id],
          function (err) {
            if (err) reject(err);
            else resolve();
          }
        );
      }
    );
  });
}

/**
 * Toggles the mastered flag for a rehearsal and returns the updated row.
 */
function toggleRehearsalMastered(id) {
  return new Promise((resolve, reject) => {
    db.get('SELECT mastered FROM rehearsals WHERE id = ?', [id], (err, row) => {
      if (err) return reject(err);
      if (!row) return resolve(null);
      const newVal = row.mastered ? 0 : 1;
      db.run(
        'UPDATE rehearsals SET mastered = ? WHERE id = ?',
        [newVal, id],
        function (err) {
          if (err) return reject(err);
          db.get(
            `SELECT r.id, r.title, r.youtube, r.spotify, r.levels_json, r.notes_json, r.audio_notes_json, r.mastered, r.creator_id, r.created_at,
                    u.username AS creator
             FROM rehearsals r JOIN users u ON u.id = r.creator_id WHERE r.id = ?`,
            [id],
            (err, updated) => {
              if (err) reject(err);
              else if (!updated) resolve(null);
              else {
                resolve({
                  id: updated.id,
                  title: updated.title,
                  youtube: updated.youtube,
                  spotify: updated.spotify,
                  levels: JSON.parse(updated.levels_json || '{}'),
                  notes: JSON.parse(updated.notes_json || '{}'),
                  audioNotes: JSON.parse(updated.audio_notes_json || '{}'),
                  mastered: !!updated.mastered,
                  creatorId: updated.creator_id,
                  creator: updated.creator,
                });
              }
            }
          );
        }
      );
    });
  });
}

/**
 * Creates a performance.
 */
function createPerformance(name, date, location, songs, creatorId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO performances (name, date, location, songs_json, creator_id) VALUES (?, ?, ?, ?, ?)',
      [name, date, location, JSON.stringify(songs || []), creatorId],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Retrieves all performances.  Parses songs_json to an array of IDs.
 */
function getPerformances() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT p.id, p.name, p.date, p.location, p.songs_json, p.creator_id, u.username AS creator
       FROM performances p
       JOIN users u ON u.id = p.creator_id
       ORDER BY p.date ASC`,
      (err, rows) => {
        if (err) reject(err);
        else {
          const result = rows.map((row) => {
            return {
              id: row.id,
              name: row.name,
              date: row.date,
              location: row.location,
              songs: JSON.parse(row.songs_json || '[]'),
              creatorId: row.creator_id,
              creator: row.creator,
            };
          });
          resolve(result);
        }
      }
    );
  });
}

/**
 * Retrieves a specific performance by id.
 */
function getPerformance(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, name, date, location, songs_json, creator_id FROM performances WHERE id = ?',
      [id],
      (err, row) => {
        if (err) reject(err);
        else if (!row) resolve(null);
        else {
          resolve({
            id: row.id,
            name: row.name,
            date: row.date,
            location: row.location,
            songs: JSON.parse(row.songs_json || '[]'),
            creatorId: row.creator_id,
          });
        }
      }
    );
  });
}

/**
 * Updates an existing performance with new name, date, and songs.  Only
 * permitted if the requesting user is the creator.  Resolves with the number
 * of updated rows (0 or 1).
 */
function updatePerformance(id, name, date, location, songs, userId, role) {
  return new Promise((resolve, reject) => {
    const sql = role === 'admin' || role === 'moderator'
      ? 'UPDATE performances SET name = ?, date = ?, location = ?, songs_json = ? WHERE id = ?'
      : 'UPDATE performances SET name = ?, date = ?, location = ?, songs_json = ? WHERE id = ? AND creator_id = ?';
    const params = role === 'admin' || role === 'moderator'
      ? [name, date, location, JSON.stringify(songs || []), id]
      : [name, date, location, JSON.stringify(songs || []), id, userId];
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Deletes a performance if the user is the creator.  Returns number of rows
 * deleted.
 */
function deletePerformance(id, userId, role) {
  return new Promise((resolve, reject) => {
    const sql = role === 'admin' || role === 'moderator'
      ? 'DELETE FROM performances WHERE id = ?'
      : 'DELETE FROM performances WHERE id = ? AND creator_id = ?';
    const params = role === 'admin' || role === 'moderator' ? [id] : [id, userId];
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Moves a suggestion to the rehearsals table. Returns the created rehearsal
 * row or null if the suggestion does not exist.
 */
function moveSuggestionToRehearsal(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, title, COALESCE(youtube, url) as youtube, creator_id FROM suggestions WHERE id = ?',
      [id],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        db.run(
          'INSERT INTO rehearsals (title, youtube, spotify, levels_json, notes_json, audio_notes_json, mastered, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [row.title, row.youtube || null, null, '{}', '{}', '{}', 0, row.creator_id],
          function (err2) {
            if (err2) return reject(err2);
            const newId = this.lastID;
            db.run('DELETE FROM suggestions WHERE id = ?', [id], (err3) => {
              if (err3) return reject(err3);
              db.get(
                `SELECT r.id, r.title, r.youtube, r.spotify, r.levels_json, r.notes_json, r.audio_notes_json, r.mastered, r.creator_id, r.created_at,
                        u.username AS creator
                 FROM rehearsals r JOIN users u ON u.id = r.creator_id WHERE r.id = ?`,
                [newId],
                (err4, rrow) => {
                  if (err4) reject(err4);
                  else if (!rrow) resolve(null);
                  else {
                    resolve({
                      id: rrow.id,
                      title: rrow.title,
                      youtube: rrow.youtube,
                      spotify: rrow.spotify,
                      levels: JSON.parse(rrow.levels_json || '{}'),
                      notes: JSON.parse(rrow.notes_json || '{}'),
                      audioNotes: JSON.parse(rrow.audio_notes_json || '{}'),
                      mastered: !!rrow.mastered,
                      creatorId: rrow.creator_id,
                      creator: rrow.creator,
                    });
                  }
                }
              );
            });
          }
        );
      }
    );
  });
}

/**
 * Moves a rehearsal back to the suggestions table. Returns the created
 * suggestion row or null if the rehearsal does not exist.
 */
function moveRehearsalToSuggestion(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, title, youtube, creator_id FROM rehearsals WHERE id = ?',
      [id],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        db.run(
          'INSERT INTO suggestions (title, author, youtube, creator_id) VALUES (?, ?, ?, ?)',
          [row.title, null, row.youtube || null, row.creator_id],
          function (err2) {
            if (err2) return reject(err2);
            const newId = this.lastID;
            db.run('DELETE FROM rehearsals WHERE id = ?', [id], (err3) => {
              if (err3) return reject(err3);
              db.get(
                `SELECT s.id, s.title, s.author, s.url, s.youtube, s.likes, s.creator_id, s.created_at, u.username AS creator
                 FROM suggestions s JOIN users u ON u.id = s.creator_id WHERE s.id = ?`,
                [newId],
                (err4, srow) => {
                  if (err4) reject(err4);
                  else resolve(srow || null);
                }
              );
            });
          }
        );
      }
    );
  });
}

/**
 * Creates a new group.
 */
function createGroup(name, invitationCode, description, logoUrl, ownerId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO groups (name, invitation_code, description, logo_url, owner_id) VALUES (?, ?, ?, ?, ?)',
      [name, invitationCode, description, logoUrl, ownerId],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Retrieves a group by ID.
 */
function getGroupById(id) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, name, invitation_code, description, logo_url, created_at, owner_id FROM groups WHERE id = ?',
      [id],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

function getGroupByCode(code) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, name, invitation_code, description, logo_url, created_at, owner_id FROM groups WHERE invitation_code = ?',
      [code],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

/**
 * Returns all groups that a given user belongs to.
 */
function getGroupsForUser(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT g.id, g.name
         FROM groups g
         JOIN memberships m ON m.group_id = g.id
         WHERE m.user_id = ? AND m.active = 1`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

/**
 * Updates an existing group. Returns the number of affected rows.
 */
function updateGroup(id, name, invitationCode, description, logoUrl) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE groups SET name = ?, invitation_code = ?, description = ?, logo_url = ? WHERE id = ?',
      [name, invitationCode, description, logoUrl, id],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

function updateGroupCode(id, invitationCode) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE groups SET invitation_code = ? WHERE id = ?',
      [invitationCode, id],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/**
 * Deletes a group by ID. Returns the number of deleted rows.
 */
function deleteGroup(id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM groups WHERE id = ?', [id], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Creates a membership linking a user to a group.
 */
function createMembership(userId, groupId, role, nickname, active = true) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO memberships (user_id, group_id, role, nickname, active) VALUES (?, ?, ?, ?, ?)',
      [userId, groupId, role, nickname, active ? 1 : 0],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Retrieves a membership for a given user and group.
 */
function getMembership(userId, groupId) {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT id, user_id, group_id, role, nickname, joined_at, active FROM memberships WHERE user_id = ? AND group_id = ?',
      [userId, groupId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

/**
 * Updates a membership by ID. Returns the number of affected rows.
 */
function updateMembership(id, role, nickname, active) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE memberships SET role = ?, nickname = ?, active = ? WHERE id = ?',
      [role, nickname, active ? 1 : 0, id],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/**
 * Lists all active memberships for a group with associated usernames.
 */
function getGroupMembers(groupId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT m.user_id AS id, u.username, m.role, m.nickname
       FROM memberships m JOIN users u ON m.user_id = u.id
       WHERE m.group_id = ? AND m.active = 1`,
      [groupId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Deletes a membership by ID. Returns the number of deleted rows.
 */
function deleteMembership(id) {
  return new Promise((resolve, reject) => {
    db.run('DELETE FROM memberships WHERE id = ?', [id], function (err) {
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Retrieves settings row.  Always returns an object with groupName and darkMode.
 */
function getSettings() {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT group_name, dark_mode, next_rehearsal_date, next_rehearsal_location FROM settings WHERE id = 1',
      (err, row) => {
        if (err) reject(err);
        else {
          resolve({
            groupName: row.group_name,
            darkMode: !!row.dark_mode,
            nextRehearsalDate: row.next_rehearsal_date || '',
            nextRehearsalLocation: row.next_rehearsal_location || '',
          });
        }
      }
    );
  });
}

/**
 * Retrieves settings for a given group.
 */
function getSettingsForGroup(groupId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT s.group_name, s.dark_mode, s.template, s.next_rehearsal_date, s.next_rehearsal_location, g.invitation_code
       FROM settings s JOIN groups g ON s.group_id = g.id
       WHERE s.group_id = ?`,
      [groupId],
      (err, row) => {
        if (err) reject(err);
        else if (!row) resolve(null);
        else {
          resolve({
            groupName: row.group_name,
            darkMode: !!row.dark_mode,
            template: row.template || 'classic',
            nextRehearsalDate: row.next_rehearsal_date || '',
            nextRehearsalLocation: row.next_rehearsal_location || '',
            invitationCode: row.invitation_code,
          });
        }
      }
    );
  });
}

/**
 * Updates settings.  Accepts groupName and darkMode (boolean).
 */
function updateSettings({ groupName, darkMode, nextRehearsalDate, nextRehearsalLocation }) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE settings SET group_name = ?, dark_mode = ?, next_rehearsal_date = ?, next_rehearsal_location = ? WHERE id = 1',
      [groupName, darkMode ? 1 : 0, nextRehearsalDate, nextRehearsalLocation],
      function (err) {
        if (err) reject(err);
        else resolve();
      }
    );
  });
}

/**
 * Inserts an event into the logs table.
 */
function logEvent(userId, action, metadata) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO logs (user_id, action, metadata) VALUES (?, ?, ?)',
      [userId, action, metadata ? JSON.stringify(metadata) : null],
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
  });
}

/**
 * Retrieves recent log entries, joined with usernames.
 */
function getLogs(limit = 100) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT l.id, l.timestamp, l.user_id, u.username, l.action, l.metadata
       FROM logs l LEFT JOIN users u ON u.id = l.user_id
       ORDER BY l.timestamp DESC LIMIT ?`,
      [limit],
      (err, rows) => {
        if (err) reject(err);
        else {
          const parsed = rows.map((r) => ({
            id: r.id,
            timestamp: r.timestamp,
            user_id: r.user_id,
            username: r.username,
            action: r.action,
            metadata: r.metadata ? JSON.parse(r.metadata) : null,
          }));
          resolve(parsed);
        }
      }
    );
  });
}

module.exports = {
  init,
  createUser,
  getUserCount,
  getUserByUsername,
  getUserById,
  addUserToGroup,
  getFirstGroupForUser,
  userHasGroup,
  getGroupById,
  addWebAuthnCredential,
  getWebAuthnCredentials,
  getWebAuthnCredentialById,
  getUsers,
  updateUserRole,
  createSuggestion,
  getSuggestions,
  getSuggestionById,
  deleteSuggestion,
  updateSuggestion,
  incrementUserSuggestionLikes,
  decrementUserSuggestionLikes,
  getUserSuggestionLikes,
  incrementSuggestionLikes,
  createRehearsal,
  getRehearsals,
  getRehearsalById,
  updateRehearsalUserData,
  toggleRehearsalMastered,
  createPerformance,
  getPerformances,
  getPerformance,
  updatePerformance,
  deletePerformance,
  getSettings,
  getSettingsForGroup,
  updateSettings,
  createGroup,
  getGroupById,
  getGroupByCode,
  getGroupsForUser,
  updateGroup,
  updateGroupCode,
  deleteGroup,
  createMembership,
  getMembership,
  getGroupMembers,
  updateMembership,
  deleteMembership,
  moveSuggestionToRehearsal,
  moveRehearsalToSuggestion,
  generateInvitationCode,
  logEvent,
  getLogs,
};
