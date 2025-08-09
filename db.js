const path = require('path');
const sqlite3 = require('sqlite3').verbose();

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
  // Users: store a unique username, a password hash and its salt.  The
  // password hash is created using PBKDF2 on the server side during
  // registration.
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

  // Suggestions: simple list of song suggestions with an optional URL and
  // the user who created it.  Each suggestion also stores a number of likes
  // used to rank the items.
  db.run(
    `CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      url TEXT,
      likes INTEGER NOT NULL DEFAULT 0,
      creator_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );`
  );

  // Votes per user on suggestions. Keeps track of how many times each
  // user voted for a specific suggestion so we can decrement later.
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

  // Ensure the likes column exists on existing databases.  Older versions of
  // the schema may not have it, so we attempt to add it and ignore errors.
  db.all('PRAGMA table_info(suggestions)', (err, rows) => {
    if (!err && rows && !rows.find((r) => r.name === 'likes')) {
      db.run('ALTER TABLE suggestions ADD COLUMN likes INTEGER NOT NULL DEFAULT 0');
    }
  });

  // Rehearsals: songs worked on during practice.  Levels and notes are stored
  // as JSON strings keyed by username so that each user can set their own
  // values independently.  We avoid separate tables for simplicity.
  db.run(
    `CREATE TABLE IF NOT EXISTS rehearsals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      youtube TEXT,
      spotify TEXT,
      levels_json TEXT DEFAULT '{}',
      notes_json TEXT DEFAULT '{}',
      mastered INTEGER NOT NULL DEFAULT 0,
      creator_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );`
  );

  // Ensure mastered column exists on old databases
  db.all('PRAGMA table_info(rehearsals)', (err, rows) => {
    if (!err && rows && !rows.find((r) => r.name === 'mastered')) {
      db.run('ALTER TABLE rehearsals ADD COLUMN mastered INTEGER NOT NULL DEFAULT 0');
    }
  });

  // Performances: gigs/presentations containing multiple rehearsal IDs and
  // associated with a creator.  Songs are stored as a JSON array of
  // integers referencing the rehearsals table.
  db.run(
    `CREATE TABLE IF NOT EXISTS performances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      date TEXT NOT NULL,
      songs_json TEXT DEFAULT '[]',
      creator_id INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (creator_id) REFERENCES users(id)
    );`
  );

  // Settings: stores a single row with group name, dark mode flag and next
  // rehearsal date/location.  We insert the default row if the table is empty.
  db.run(
    `CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      group_name TEXT NOT NULL,
      dark_mode INTEGER NOT NULL DEFAULT 0,
      next_rehearsal_date TEXT,
      next_rehearsal_location TEXT
    );`,
    () => {
      // Insert default row if not present
      db.get('SELECT COUNT(*) AS count FROM settings', (err, row) => {
        if (!err && row && row.count === 0) {
          db.run(
            "INSERT INTO settings (id, group_name, dark_mode, next_rehearsal_date, next_rehearsal_location) VALUES (1, ?, 0, '', '')",
            ['Groupe de musique']
          );
        }
      });
    }
  );

  // Ensure next_rehearsal_date/location columns exist on old databases
  db.all('PRAGMA table_info(settings)', (err, rows) => {
    if (!err && rows && !rows.find((r) => r.name === 'next_rehearsal_date')) {
      db.run('ALTER TABLE settings ADD COLUMN next_rehearsal_date TEXT');
    }
    if (!err && rows && !rows.find((r) => r.name === 'next_rehearsal_location')) {
      db.run('ALTER TABLE settings ADD COLUMN next_rehearsal_location TEXT');
    }
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
      if (err) reject(err);
      else resolve(this.changes);
    });
  });
}

/**
 * Creates a new suggestion.
 */
function createSuggestion(title, url, creatorId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO suggestions (title, url, creator_id) VALUES (?, ?, ?)',
      [title, url, creatorId],
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
function getSuggestions() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT s.id, s.title, s.url, s.likes, s.creator_id, s.created_at, u.username AS creator
       FROM suggestions s
       JOIN users u ON u.id = s.creator_id
       ORDER BY s.likes DESC, s.created_at ASC`,
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      }
    );
  });
}

/**
 * Deletes a suggestion if the given user is the creator.  Returns the number
 * of rows deleted.
 */
function deleteSuggestion(id, userId, role) {
  return new Promise((resolve, reject) => {
    const sql = role === 'admin' || role === 'moderator'
      ? 'DELETE FROM suggestions WHERE id = ?'
      : 'DELETE FROM suggestions WHERE id = ? AND creator_id = ?';
    const params = role === 'admin' || role === 'moderator' ? [id] : [id, userId];
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
function updateSuggestion(id, title, url, userId, role) {
  return new Promise((resolve, reject) => {
    const sql = role === 'admin' || role === 'moderator'
      ? 'UPDATE suggestions SET title = ?, url = ? WHERE id = ?'
      : 'UPDATE suggestions SET title = ?, url = ? WHERE id = ? AND creator_id = ?';
    const params = role === 'admin' || role === 'moderator'
      ? [title, url, id]
      : [title, url, id, userId];
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
function createRehearsal(title, youtube, spotify, creatorId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO rehearsals (title, youtube, spotify, levels_json, notes_json, mastered, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [title, youtube || null, spotify || null, '{}', '{}', 0, creatorId],
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
function getRehearsals() {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT r.id, r.title, r.youtube, r.spotify, r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at,
              u.username AS creator
       FROM rehearsals r
       JOIN users u ON u.id = r.creator_id
       ORDER BY r.created_at ASC`,
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
 * Updates the level and note for the given rehearsal and user.  Only the
 * current user's values are changed.  Returns a promise.
 */
function updateRehearsalUserData(id, username, level, note) {
  return new Promise((resolve, reject) => {
    // Retrieve existing levels and notes
    db.get(
      'SELECT levels_json, notes_json FROM rehearsals WHERE id = ?',
      [id],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return reject(new Error('Rehearsal not found'));
        const levels = JSON.parse(row.levels_json || '{}');
        const notes = JSON.parse(row.notes_json || '{}');
        if (level !== undefined) {
          levels[username] = level;
        }
        if (note !== undefined) {
          notes[username] = note;
        }
        db.run(
          'UPDATE rehearsals SET levels_json = ?, notes_json = ? WHERE id = ?',
          [JSON.stringify(levels), JSON.stringify(notes), id],
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
            `SELECT r.id, r.title, r.youtube, r.spotify, r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at,
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
function createPerformance(name, date, songs, creatorId) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT INTO performances (name, date, songs_json, creator_id) VALUES (?, ?, ?, ?)',
      [name, date, JSON.stringify(songs || []), creatorId],
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
      `SELECT p.id, p.name, p.date, p.songs_json, p.creator_id, u.username AS creator
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
      'SELECT id, name, date, songs_json, creator_id FROM performances WHERE id = ?',
      [id],
      (err, row) => {
        if (err) reject(err);
        else if (!row) resolve(null);
        else {
          resolve({
            id: row.id,
            name: row.name,
            date: row.date,
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
function updatePerformance(id, name, date, songs, userId, role) {
  return new Promise((resolve, reject) => {
    const sql = role === 'admin' || role === 'moderator'
      ? 'UPDATE performances SET name = ?, date = ?, songs_json = ? WHERE id = ?'
      : 'UPDATE performances SET name = ?, date = ?, songs_json = ? WHERE id = ? AND creator_id = ?';
    const params = role === 'admin' || role === 'moderator'
      ? [name, date, JSON.stringify(songs || []), id]
      : [name, date, JSON.stringify(songs || []), id, userId];
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
      'SELECT id, title, url, creator_id FROM suggestions WHERE id = ?',
      [id],
      (err, row) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        db.run(
          'INSERT INTO rehearsals (title, youtube, spotify, levels_json, notes_json, mastered, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [row.title, row.url || null, null, '{}', '{}', 0, row.creator_id],
          function (err2) {
            if (err2) return reject(err2);
            const newId = this.lastID;
            db.run('DELETE FROM suggestions WHERE id = ?', [id], (err3) => {
              if (err3) return reject(err3);
              db.get(
                `SELECT r.id, r.title, r.youtube, r.spotify, r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at,
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
          'INSERT INTO suggestions (title, url, creator_id) VALUES (?, ?, ?)',
          [row.title, row.youtube || null, row.creator_id],
          function (err2) {
            if (err2) return reject(err2);
            const newId = this.lastID;
            db.run('DELETE FROM rehearsals WHERE id = ?', [id], (err3) => {
              if (err3) return reject(err3);
              db.get(
                `SELECT s.id, s.title, s.url, s.likes, s.creator_id, s.created_at, u.username AS creator
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

module.exports = {
  init,
  createUser,
  getUserCount,
  getUserByUsername,
  getUsers,
  updateUserRole,
  createSuggestion,
  getSuggestions,
  deleteSuggestion,
  updateSuggestion,
  incrementUserSuggestionLikes,
  decrementUserSuggestionLikes,
  getUserSuggestionLikes,
  incrementSuggestionLikes,
  createRehearsal,
  getRehearsals,
  updateRehearsalUserData,
  toggleRehearsalMastered,
  createPerformance,
  getPerformances,
  getPerformance,
  updatePerformance,
  deletePerformance,
  getSettings,
  updateSettings,
  moveSuggestionToRehearsal,
  moveRehearsalToSuggestion,
};
