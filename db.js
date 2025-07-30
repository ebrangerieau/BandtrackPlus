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
  // Users: store a unique username and a password hash.  The password
  // hash is created using bcrypt on the server side during registration.
  db.run(
    `CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );`
  );

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

  // Settings: stores a single row with group name and dark mode flag.  We
  // insert the default row if the table is empty.
  db.run(
    `CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      group_name TEXT NOT NULL,
      dark_mode INTEGER NOT NULL DEFAULT 0
    );`,
    () => {
      // Insert default row if not present
      db.get('SELECT COUNT(*) AS count FROM settings', (err, row) => {
        if (!err && row && row.count === 0) {
          db.run(
            'INSERT INTO settings (id, group_name, dark_mode) VALUES (1, ?, 0)',
            ['Groupe de musique']
          );
        }
      });
    }
  );
}

/**
 * Creates a new user with the given username and hashed password.  Returns
 * a promise that resolves to the inserted user ID.
 * @param {string} username
 * @param {string} passwordHash
 */
function createUser(username, passwordHash) {
  return new Promise((resolve, reject) => {
    const stmt = db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      function (err) {
        if (err) reject(err);
        else resolve(this.lastID);
      }
    );
    stmt.run(username, passwordHash);
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
      'SELECT id, username, password_hash FROM users WHERE username = ?',
      [username],
      (err, row) => {
        if (err) reject(err);
        else resolve(row);
      }
    );
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
function deleteSuggestion(id, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM suggestions WHERE id = ? AND creator_id = ?',
      [id, userId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/**
 * Updates a suggestion title and URL if the user is the creator.
 * Resolves with the number of updated rows (0 or 1).
 */
function updateSuggestion(id, title, url, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE suggestions SET title = ?, url = ? WHERE id = ? AND creator_id = ?',
      [title, url, id, userId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/**
 * Increments the like counter for a suggestion.  Resolves to true if a row was
 * updated.
 */
function incrementSuggestionLikes(id) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE suggestions SET likes = likes + 1 WHERE id = ?',
      [id],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
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
function updatePerformance(id, name, date, songs, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE performances SET name = ?, date = ?, songs_json = ? WHERE id = ? AND creator_id = ?',
      [name, date, JSON.stringify(songs || []), id, userId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/**
 * Deletes a performance if the user is the creator.  Returns number of rows
 * deleted.
 */
function deletePerformance(id, userId) {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM performances WHERE id = ? AND creator_id = ?',
      [id, userId],
      function (err) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

/**
 * Retrieves settings row.  Always returns an object with groupName and darkMode.
 */
function getSettings() {
  return new Promise((resolve, reject) => {
    db.get('SELECT group_name, dark_mode FROM settings WHERE id = 1', (err, row) => {
      if (err) reject(err);
      else {
        resolve({ groupName: row.group_name, darkMode: !!row.dark_mode });
      }
    });
  });
}

/**
 * Updates settings.  Accepts groupName and darkMode (boolean).
 */
function updateSettings({ groupName, darkMode }) {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE settings SET group_name = ?, dark_mode = ? WHERE id = 1',
      [groupName, darkMode ? 1 : 0],
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
  getUserByUsername,
  createSuggestion,
  getSuggestions,
  deleteSuggestion,
  updateSuggestion,
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
};