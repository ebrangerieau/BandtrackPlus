#!/usr/bin/env python3
"""
bandtrack-server/server.py
==========================

This module implements a simple HTTP server in pure Python to provide a
centralised backend for the BandTrack application.  It serves both the
frontend files (the SPA in the ``public`` directory) and a JSON API
under the ``/api`` prefix.  The design follows the architecture proposed
for replacing the original ``localStorage`` implementation with a
database-backed server and cookie‑based session management.  By using
only the Python standard library, the server avoids any external
dependencies and is suitable for containerised environments where
internet access is unavailable.

Key features
------------

* Users can register and login.  Passwords are salted and hashed using
  PBKDF2 with SHA‑256 for security.  Sessions are stored in a
  ``sessions`` table and identified via a randomly generated cookie.
* Suggestions, rehearsals and performances are persisted in a SQLite
  database (`bandtrack.db`) with the same structure as the earlier
  Node/Express prototype.
* A single settings row stores the group name and dark mode flag, which
  are applied at load time for all users.
* The API endpoints mirror those used by the frontend so that the
  existing JavaScript code (in ``public/app.js``) can remain largely
  unchanged.  The only notable difference is that cookie names and
  expiration behaviour are handled here.
* Static files are served from the ``public`` directory for any path
  outside of ``/api``.  Unknown paths fall back to ``index.html`` to
  support client‑side routing in the SPA.

Usage
-----

Running the server is as simple as executing this file with Python:

```
python3 server.py
```

The server listens on port 3000 by default.  You can override the port
by setting the ``PORT`` environment variable or passing ``--port`` on
the command line.  Example:

```
python3 server.py --port 8080
```

The server automatically creates the database and tables on first run,
and inserts a default settings row if none exists.  Data persists in
``bandtrack.db`` across restarts.

Note: Because this server runs on the same domain as the frontend, no
CORS headers are necessary.  The session cookie is marked ``HttpOnly``
and ``SameSite=Lax`` to mitigate cross‑site scripting and request
forgery attacks.  HTTPS termination should be handled by an upstream
proxy in production.
"""

import argparse
import json
import os
import sqlite3
import secrets
import string
import hashlib
import hmac
import time
import datetime
import urllib.parse
import mimetypes
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

#############################
# Database initialisation
#############################

DB_FILENAME = os.path.join(os.path.dirname(__file__), 'bandtrack.db')

def get_db_connection():
    """Return a new database connection.  SQLite connections are not
    thread‑safe by default when used from multiple threads (as in
    ``ThreadingHTTPServer``).  Consequently, each request handler
    obtains its own connection.  ``check_same_thread=False`` allows
    connections to be shared across threads safely."""
    conn = sqlite3.connect(DB_FILENAME, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    """Create tables if they do not already exist and insert the
    default settings row.  This function is idempotent."""
    conn = get_db_connection()
    cur = conn.cursor()
    # Users table: store username, salt and password hash
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS users (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               username TEXT NOT NULL UNIQUE,
               salt BLOB NOT NULL,
               password_hash BLOB NOT NULL,
               role TEXT NOT NULL DEFAULT 'user'
           );'''
    )
    # Suggestions: simple list of suggestions with optional URL and creator
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS suggestions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               title TEXT NOT NULL,
               author TEXT,
               youtube TEXT,
               url TEXT,
               likes INTEGER NOT NULL DEFAULT 0,
               creator_id INTEGER NOT NULL,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY (creator_id) REFERENCES users(id)
           );'''
    )
    # Rehearsals: store levels and notes per user as JSON strings.  Include
    # optional author, YouTube/Spotify links and audio notes JSON.  The
    # ``audio_notes_json`` field stores base64‑encoded audio notes per user.
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS rehearsals (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               title TEXT NOT NULL,
               author TEXT,
               youtube TEXT,
               spotify TEXT,
               levels_json TEXT DEFAULT '{}',
               notes_json TEXT DEFAULT '{}',
               audio_notes_json TEXT DEFAULT '{}',
               mastered INTEGER NOT NULL DEFAULT 0,
               creator_id INTEGER NOT NULL,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY (creator_id) REFERENCES users(id)
           );'''
    )
    # Performances: contains name, date and a JSON array of rehearsal IDs
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS performances (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               date TEXT NOT NULL,
               songs_json TEXT DEFAULT '[]',
               creator_id INTEGER NOT NULL,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               FOREIGN KEY (creator_id) REFERENCES users(id)
           );'''
    )
    # Groups allow multiple band configurations and are owned by a user
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS groups (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL,
               invitation_code TEXT NOT NULL UNIQUE,
               description TEXT,
               logo_url TEXT,
               created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               owner_id INTEGER NOT NULL,
               FOREIGN KEY (owner_id) REFERENCES users(id)
           );'''
    )
    # Memberships link users to groups with a role and optional nickname
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS memberships (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               user_id INTEGER NOT NULL,
               group_id INTEGER NOT NULL,
               role TEXT NOT NULL,
               nickname TEXT,
               joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
               active INTEGER NOT NULL DEFAULT 1,
               FOREIGN KEY (user_id) REFERENCES users(id),
               FOREIGN KEY (group_id) REFERENCES groups(id)
           );'''
    )
    # Index for quick lookup of a membership by user and group
    cur.execute(
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_memberships_user_group ON memberships(user_id, group_id)'
    )
    # Settings: single row with group name, dark mode flag and optional
    # next rehearsal info.  "template" selects the UI theme.
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS settings (
               id INTEGER PRIMARY KEY CHECK(id=1),
               group_name TEXT NOT NULL,
               dark_mode INTEGER NOT NULL DEFAULT 0,
               template TEXT NOT NULL DEFAULT 'classic',
               next_rehearsal_date TEXT,
               next_rehearsal_location TEXT
           );'''
    )
    # Insert default settings row if missing
    cur.execute('SELECT COUNT(*) FROM settings')
    if cur.fetchone()[0] == 0:
        cur.execute(
            'INSERT INTO settings (id, group_name, dark_mode, template, next_rehearsal_date, next_rehearsal_location) '
            "VALUES (1, ?, 0, ?, '', '')",
            ('Groupe de musique', 'classic')
        )
    # Sessions: store session token, associated user and expiry timestamp (epoch)
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS sessions (
               token TEXT PRIMARY KEY,
               user_id INTEGER NOT NULL,
               expires_at INTEGER NOT NULL,
               FOREIGN KEY (user_id) REFERENCES users(id)
           );'''
    )
    # Logs: record key user actions
    cur.execute(
        '''CREATE TABLE IF NOT EXISTS logs (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
               user_id INTEGER,
               action TEXT NOT NULL,
               metadata TEXT,
               FOREIGN KEY (user_id) REFERENCES users(id)
           );'''
    )
    conn.commit()
    conn.close()

    # Ensure additional columns are present in existing databases.  SQLite
    # will raise an OperationalError if a column already exists; we
    # silently ignore such errors.  Users table: role
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('PRAGMA table_info(users)')
        columns = [row['name'] for row in cur.fetchall()]
        if 'role' not in columns:
            cur.execute("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'")
            conn.commit()
        conn.close()
    except Exception:
        pass
    # Suggestions table: ensure 'author' and 'youtube' columns exist
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('PRAGMA table_info(suggestions)')
        s_columns = [row['name'] for row in cur.fetchall()]
        if 'author' not in s_columns:
            cur.execute('ALTER TABLE suggestions ADD COLUMN author TEXT')
        if 'youtube' not in s_columns:
            cur.execute('ALTER TABLE suggestions ADD COLUMN youtube TEXT')
        if 'likes' not in s_columns:
            cur.execute('ALTER TABLE suggestions ADD COLUMN likes INTEGER NOT NULL DEFAULT 0')
        # Keep existing url column intact for backward compatibility
        conn.commit()
        conn.close()
    except Exception:
        pass
    # Rehearsals table: ensure 'author' and 'audio_notes_json' columns exist
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('PRAGMA table_info(rehearsals)')
        r_columns = [row['name'] for row in cur.fetchall()]
        if 'author' not in r_columns:
            cur.execute('ALTER TABLE rehearsals ADD COLUMN author TEXT')
        if 'audio_notes_json' not in r_columns:
            cur.execute("ALTER TABLE rehearsals ADD COLUMN audio_notes_json TEXT DEFAULT '{}'")
        if 'mastered' not in r_columns:
            cur.execute('ALTER TABLE rehearsals ADD COLUMN mastered INTEGER NOT NULL DEFAULT 0')
        conn.commit()
        conn.close()
    except Exception:
        pass

    # Settings table: ensure newer columns exist.  Older databases may lack
    # the "template" or next rehearsal fields, so add them if missing.
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('PRAGMA table_info(settings)')
        settings_columns = [row['name'] for row in cur.fetchall()]
        if 'template' not in settings_columns:
            cur.execute("ALTER TABLE settings ADD COLUMN template TEXT NOT NULL DEFAULT 'classic'")
        if 'next_rehearsal_date' not in settings_columns:
            cur.execute('ALTER TABLE settings ADD COLUMN next_rehearsal_date TEXT')
        if 'next_rehearsal_location' not in settings_columns:
            cur.execute('ALTER TABLE settings ADD COLUMN next_rehearsal_location TEXT')
        conn.commit()
        conn.close()
    except Exception:
        pass

    # Groups and memberships.  Multiple groups are supported so users can
    # belong to several ensembles.  We create a default group with id 1 for
    # backward compatibility and for fresh installations.
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            '''CREATE TABLE IF NOT EXISTS groups (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL UNIQUE
               );'''
        )
        cur.execute(
            '''CREATE TABLE IF NOT EXISTS group_members (
                   user_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   PRIMARY KEY (user_id, group_id),
                   FOREIGN KEY (user_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        # Ensure a default group exists
        cur.execute('INSERT OR IGNORE INTO groups (id, name) VALUES (1, ?)', ('Groupe de musique',))
        conn.commit()
        conn.close()
    except Exception:
        pass

    # Sessions table: ensure a group_id column exists to store the active
    # group for a session.
    try:
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('PRAGMA table_info(sessions)')
        sess_columns = [row['name'] for row in cur.fetchall()]
        if 'group_id' not in sess_columns:
            cur.execute('ALTER TABLE sessions ADD COLUMN group_id INTEGER')
        conn.commit()
        conn.close()
    except Exception:
        pass

#############################
# Helper functions
#############################

def hash_password(password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    """Hash a password with PBKDF2.  If ``salt`` is None, a new 16‑byte salt
    is generated.  Returns a tuple of (salt, password_hash)."""
    if salt is None:
        salt = os.urandom(16)
    # Use PBKDF2 with SHA‑256 and 100_000 iterations (reasonable trade‑off)
    hashed = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100_000)
    return salt, hashed

def verify_password(password: str, salt: bytes, expected_hash: bytes) -> bool:
    """Verify a password against a stored salt and hash."""
    salt, hashed = hash_password(password, salt)
    # Constant‑time comparison to avoid timing attacks
    return hmac.compare_digest(hashed, expected_hash)


def generate_invitation_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def generate_unique_invitation_code() -> str:
    conn = get_db_connection()
    cur = conn.cursor()
    while True:
        code = generate_invitation_code()
        cur.execute('SELECT 1 FROM groups WHERE invitation_code = ?', (code,))
        if cur.fetchone() is None:
            conn.close()
            return code

def generate_session(user_id: int, group_id: int | None, duration_seconds: int = 7 * 24 * 3600) -> str:
    """Create a new session token for a user and store it with the active
    group in the database.  ``duration_seconds`` controls the cookie's
    lifetime; default is one week."""
    token = secrets.token_hex(32)
    expires_at = int(time.time()) + duration_seconds
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'INSERT INTO sessions (token, user_id, group_id, expires_at) VALUES (?, ?, ?, ?)',
        (token, user_id, group_id, expires_at)
    )
    conn.commit()
    conn.close()
    return token

def get_user_by_session(token: str) -> dict | None:
    """Retrieve the user associated with a session token.  Returns a dict
    representing the user row or ``None`` if the session is invalid or
    expired.  Expired sessions are removed from the database."""
    if not token:
        return None
    conn = get_db_connection()
    cur = conn.cursor()
    # Remove expired sessions
    cur.execute('DELETE FROM sessions WHERE expires_at <= ?', (int(time.time()),))
    # Fetch the session
    cur.execute(
        'SELECT user_id, group_id FROM sessions WHERE token = ?',
        (token,)
    )
    row = cur.fetchone()
    if not row:
        conn.commit()
        conn.close()
        return None
    user_id = row['user_id']
    group_id = row['group_id']
    # Extend session expiry on each use (sliding window)
    new_expires = int(time.time()) + 7 * 24 * 3600
    cur.execute(
        'UPDATE sessions SET expires_at = ? WHERE token = ?',
        (new_expires, token)
    )
    # Fetch the user along with their role
    cur.execute(
        'SELECT id, username, role FROM users WHERE id = ?',
        (user_id,)
    )
    user_row = cur.fetchone()
    conn.commit()
    conn.close()
    if user_row:
        return {
            'id': user_row['id'],
            'username': user_row['username'],
            'role': user_row['role'],
            'group_id': group_id,
        }
    return None

def delete_session(token: str) -> None:
    """Invalidate a session by removing it from the database."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('DELETE FROM sessions WHERE token = ?', (token,))
    conn.commit()
    conn.close()

def log_event(user_id: int | None, action: str, metadata: dict | None = None) -> None:
    """Insert an entry into the logs table."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'INSERT INTO logs (user_id, action, metadata) VALUES (?, ?, ?)',
        (user_id, action, json.dumps(metadata or {}))
    )
    conn.commit()
    conn.close()

def read_request_body(handler: BaseHTTPRequestHandler) -> bytes:
    """Read and return the request body for the current request.  If the
    Content‑Length header is missing or invalid, returns empty bytes."""
    try:
        length = int(handler.headers.get('Content-Length', 0))
    except ValueError:
        return b''
    return handler.rfile.read(length) if length > 0 else b''

def send_json(handler: BaseHTTPRequestHandler, status: int, data: dict, *, cookies: list[tuple[str, str, dict]] = None) -> None:
    """Serialize ``data`` to JSON and send it in the response with the given
    HTTP status code.  ``cookies`` can be a list of tuples in the form
    ``(name, value, options)`` where options is a dict of cookie
    attributes (expires, path, samesite, httponly, etc.)."""
    payload = json.dumps(data).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Content-Length', str(len(payload)))
    if cookies:
        for (name, value, opts) in cookies:
            cookie_parts = [f"{name}={value}"]
            if 'expires' in opts:
                # HTTP cookie format for expires: Wdy, DD Mon YYYY HH:MM:SS GMT
                exp_ts = opts['expires']
                if isinstance(exp_ts, int):
                    exp_dt = datetime.datetime.utcfromtimestamp(exp_ts)
                else:
                    exp_dt = exp_ts
                cookie_parts.append('Expires=' + exp_dt.strftime('%a, %d %b %Y %H:%M:%S GMT'))
            if 'path' in opts:
                cookie_parts.append(f"Path={opts['path']}")
            if 'samesite' in opts:
                cookie_parts.append(f"SameSite={opts['samesite']}")
            if opts.get('httponly'):
                cookie_parts.append('HttpOnly')
            if opts.get('secure'):
                cookie_parts.append('Secure')
            handler.send_header('Set-Cookie', '; '.join(cookie_parts))
    handler.end_headers()
    handler.wfile.write(payload)

def send_text_file(handler: BaseHTTPRequestHandler, filepath: str) -> None:
    """Serve a static file from disk.  Sets an appropriate MIME type.
    If the file is not found, a 404 response is sent instead."""
    if not os.path.isfile(filepath):
        handler.send_error(HTTPStatus.NOT_FOUND)
        return
    # Guess content type
    mime, _ = mimetypes.guess_type(filepath)
    if not mime:
        mime = 'application/octet-stream'
    try:
        with open(filepath, 'rb') as f:
            data = f.read()
        handler.send_response(HTTPStatus.OK)
        handler.send_header('Content-Type', mime)
        handler.send_header('Content-Length', str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
    except OSError:
        handler.send_error(HTTPStatus.INTERNAL_SERVER_ERROR)

def move_suggestion_to_rehearsal(sug_id: int):
    """Create a rehearsal from a suggestion and remove the suggestion."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'SELECT title, author, youtube, url, creator_id FROM suggestions WHERE id = ?',
        (sug_id,)
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        return None
    yt = row['youtube'] or row['url']
    cur.execute(
        'INSERT INTO rehearsals (title, author, youtube, spotify, levels_json, notes_json, audio_notes_json, mastered, creator_id) '
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        (row['title'], row['author'], yt, None, json.dumps({}), json.dumps({}), json.dumps({}), 0, row['creator_id']),
    )
    new_id = cur.lastrowid
    cur.execute(
        '''SELECT r.id, r.title, r.author, r.youtube, r.spotify, r.audio_notes_json,
                  r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at,
                  u.username AS creator FROM rehearsals r JOIN users u ON u.id = r.creator_id
           WHERE r.id = ?''',
        (new_id,),
    )
    new_row = cur.fetchone()
    cur.execute('DELETE FROM suggestions WHERE id = ?', (sug_id,))
    conn.commit()
    conn.close()
    if not new_row:
        return None
    return {
        'id': new_row['id'],
        'title': new_row['title'],
        'author': new_row['author'],
        'youtube': new_row['youtube'],
        'spotify': new_row['spotify'],
        'audioNotes': json.loads(new_row['audio_notes_json'] or '{}'),
        'levels': json.loads(new_row['levels_json'] or '{}'),
        'notes': json.loads(new_row['notes_json'] or '{}'),
        'mastered': bool(new_row['mastered']),
        'creatorId': new_row['creator_id'],
        'creator': new_row['creator'],
        'createdAt': new_row['created_at'],
    }

def move_rehearsal_to_suggestion(reh_id: int):
    """Create a suggestion from a rehearsal and remove the rehearsal."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'SELECT title, author, youtube, creator_id FROM rehearsals WHERE id = ?',
        (reh_id,),
    )
    row = cur.fetchone()
    if not row:
        conn.close()
        return None
    cur.execute(
        'INSERT INTO suggestions (title, author, youtube, url, likes, creator_id) VALUES (?, ?, ?, ?, 0, ?)',
        (row['title'], row['author'], row['youtube'], row['youtube'], row['creator_id']),
    )
    new_id = cur.lastrowid
    cur.execute(
        '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.likes, s.creator_id, s.created_at,
                  u.username AS creator FROM suggestions s JOIN users u ON u.id = s.creator_id
           WHERE s.id = ?''',
        (new_id,),
    )
    new_row = cur.fetchone()
    cur.execute('DELETE FROM rehearsals WHERE id = ?', (reh_id,))
    conn.commit()
    conn.close()
    if not new_row:
        return None
    return {
        'id': new_row['id'],
        'title': new_row['title'],
        'author': new_row['author'],
        'youtube': new_row['youtube'] or new_row['url'],
        'creatorId': new_row['creator_id'],
        'creator': new_row['creator'],
        'createdAt': new_row['created_at'],
        'likes': new_row['likes'],
    }


def create_group(name: str, invitation_code: str, description: str | None, logo_url: str | None, owner_id: int) -> int:
    """Insert a new group and return its ID."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'INSERT INTO groups (name, invitation_code, description, logo_url, owner_id) VALUES (?, ?, ?, ?, ?)',
        (name, invitation_code, description, logo_url, owner_id),
    )
    group_id = cur.lastrowid
    conn.commit()
    conn.close()
    return group_id


def get_group_by_id(group_id: int) -> dict | None:
    """Fetch a group by its ID."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'SELECT id, name, invitation_code, description, logo_url, created_at, owner_id FROM groups WHERE id = ?',
        (group_id,),
    )
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None


def get_group_by_code(code: str) -> dict | None:
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'SELECT id, name, invitation_code, description, logo_url, created_at, owner_id FROM groups WHERE invitation_code = ?',
        (code,),
    )
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None


def update_group(group_id: int, name: str, invitation_code: str, description: str | None, logo_url: str | None) -> int:
    """Update a group's details.  Returns number of affected rows."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'UPDATE groups SET name = ?, invitation_code = ?, description = ?, logo_url = ? WHERE id = ?',
        (name, invitation_code, description, logo_url, group_id),
    )
    conn.commit()
    changes = cur.rowcount
    conn.close()
    return changes


def update_group_code(group_id: int, invitation_code: str) -> int:
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('UPDATE groups SET invitation_code = ? WHERE id = ?', (invitation_code, group_id))
    conn.commit()
    changes = cur.rowcount
    conn.close()
    return changes


def delete_group(group_id: int) -> int:
    """Delete a group by ID.  Returns the number of deleted rows."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('DELETE FROM groups WHERE id = ?', (group_id,))
    conn.commit()
    changes = cur.rowcount
    conn.close()
    return changes


def create_membership(user_id: int, group_id: int, role: str, nickname: str | None, active: bool = True) -> int:
    """Create a membership entry linking a user to a group."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'INSERT INTO memberships (user_id, group_id, role, nickname, active) VALUES (?, ?, ?, ?, ?)',
        (user_id, group_id, role, nickname, 1 if active else 0),
    )
    membership_id = cur.lastrowid
    conn.commit()
    conn.close()
    return membership_id


def get_membership(user_id: int, group_id: int) -> dict | None:
    """Retrieve a membership for a user/group pair."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'SELECT id, user_id, group_id, role, nickname, joined_at, active FROM memberships WHERE user_id = ? AND group_id = ?',
        (user_id, group_id),
    )
    row = cur.fetchone()
    conn.close()
    return dict(row) if row else None


def update_membership(membership_id: int, role: str, nickname: str | None, active: bool) -> int:
    """Update membership details.  Returns number of affected rows."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute(
        'UPDATE memberships SET role = ?, nickname = ?, active = ? WHERE id = ?',
        (role, nickname, 1 if active else 0, membership_id),
    )
    conn.commit()
    changes = cur.rowcount
    conn.close()
    return changes


def delete_membership(membership_id: int) -> int:
    """Delete a membership by its ID."""
    conn = get_db_connection()
    cur = conn.cursor()
    cur.execute('DELETE FROM memberships WHERE id = ?', (membership_id,))
    conn.commit()
    changes = cur.rowcount
    conn.close()
    return changes

#############################
# HTTP request handler
#############################

class BandTrackHandler(BaseHTTPRequestHandler):
    """Request handler implementing both API and static file serving."""

    server_version = 'BandTrack/1.0'

    def do_OPTIONS(self):  # noqa: N802 (matching http.server naming)
        """Handle CORS preflight requests if needed.  Since the server and
        client run on the same origin in our deployment, CORS is not
        strictly necessary.  However, we respond to OPTIONS with a 200
        status to be conservative."""
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header('Allow', 'OPTIONS, GET, POST, PUT, DELETE')
        self.end_headers()

    def do_GET(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith('/api/'):
            self.handle_api_request('GET', path, urllib.parse.parse_qs(parsed.query))
        else:
            # Serve static file.  Remove leading '/' and normalise path
            local_path = path.lstrip('/') or 'index.html'
            static_root = os.path.join(os.path.dirname(__file__), 'public')
            # Prevent directory traversal
            normalized = os.path.normpath(os.path.join(static_root, local_path))
            if not normalized.startswith(static_root):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            if os.path.isdir(normalized):
                normalized = os.path.join(normalized, 'index.html')
            # Fall back to index.html for client routing (e.g. /performances)
            if not os.path.isfile(normalized):
                normalized = os.path.join(static_root, 'index.html')
            send_text_file(self, normalized)

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith('/api/'):
            self.handle_api_request('POST', parsed.path, urllib.parse.parse_qs(parsed.query))
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_PUT(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith('/api/'):
            self.handle_api_request('PUT', parsed.path, urllib.parse.parse_qs(parsed.query))
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_DELETE(self):  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith('/api/'):
            self.handle_api_request('DELETE', parsed.path, urllib.parse.parse_qs(parsed.query))
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def handle_api_request(self, method: str, path: str, query: dict[str, list[str]]):
        """Dispatch API requests based on the path and HTTP method."""
        # Parse JSON body if present.  HTTP methods that typically carry
        # a body include POST, PUT and DELETE.  We intentionally
        # include DELETE here because curl and fetch may send JSON
        # payloads with DELETE requests even though the RFC does not
        # require servers to accept them.  For other methods we ignore
        # the body.
        if method in ('POST', 'PUT', 'DELETE'):
            body_bytes = read_request_body(self)
            try:
                body = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
            except json.JSONDecodeError:
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid JSON'})
                return
        else:
            body = {}

        # Authentication: obtain current user via session cookie
        cookie_header = self.headers.get('Cookie', '')
        cookies = {}
        for part in cookie_header.split(';'):
            if '=' in part:
                name, value = part.strip().split('=', 1)
                cookies[name] = value
        session_token = cookies.get('session_id')
        user = get_user_by_session(session_token)

        # Route handling
        try:
            # Authentication routes that do not require an existing session
            if path == '/api/register' and method == 'POST':
                return self.api_register(body)
            if path == '/api/login' and method == 'POST':
                return self.api_login(body)
            if path == '/api/logout' and method == 'POST':
                return self.api_logout(session_token)
            if path == '/api/me' and method == 'GET':
                return self.api_me(user)

            # Remaining routes require authentication and an active group
            if user is None or user.get('group_id') is None:
                raise PermissionError

            # Context endpoints
            if path == '/api/context':
                if method == 'GET':
                    return self.api_get_context(user)
                if method == 'PUT':
                    return self.api_set_context(body, user, session_token)

            # Group management
            if path == '/api/groups' and method == 'POST':
                return self.api_create_group(body, user)
            if path == '/api/groups/join' and method == 'POST':
                return self.api_join_group(body, user)
            if path == '/api/groups/renew-code' and method == 'POST':
                return self.api_renew_group_code(user)

            # Suggestions
            if path.startswith('/api/suggestions'):
                parts = path.split('/')
                # e.g. /api/suggestions or /api/suggestions/
                if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
                    if method == 'GET':
                        return self.api_get_suggestions()
                    if method == 'POST':
                        return self.api_create_suggestion(body, user)
                    raise NotImplementedError
                # e.g. /api/suggestions/{id}
                if len(parts) >= 4:
                    try:
                        sug_id = int(parts[3])
                    except ValueError:
                        return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
                    if len(parts) == 5 and parts[4] == 'to-rehearsal' and method == 'POST':
                        return self.api_move_suggestion_to_rehearsal_id(sug_id)
                    if len(parts) == 5 and parts[4] == 'vote':
                        if method == 'POST':
                            return self.api_vote_suggestion_id(sug_id, user)
                        if method == 'DELETE':
                            return self.api_unvote_suggestion_id(sug_id, user)
                        raise NotImplementedError
                    if method == 'PUT':
                        return self.api_update_suggestion_id(sug_id, body, user)
                    if method == 'DELETE':
                        return self.api_delete_suggestion_id(sug_id, user)
                    else:
                        raise NotImplementedError
                # any other variation
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            # Rehearsals
            if path.startswith('/api/rehearsals'):
                parts = path.split('/')
                if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
                    if method == 'GET':
                        return self.api_get_rehearsals()
                    if method == 'POST':
                        return self.api_create_rehearsal(body, user)
                    raise NotImplementedError
                if len(parts) == 4:
                    try:
                        reh_id = int(parts[3])
                    except ValueError:
                        return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
                    if method == 'PUT':
                        return self.api_update_rehearsal_id(reh_id, body, user)
                    if method == 'DELETE':
                        return self.api_delete_rehearsal_id(reh_id, user)
                    else:
                        raise NotImplementedError
                if len(parts) == 5 and parts[4] == 'mastered' and method == 'PUT':
                    try:
                        reh_id = int(parts[3])
                    except ValueError:
                        return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
                    return self.api_toggle_rehearsal_mastered(reh_id, user)
                if len(parts) == 5 and parts[4] == 'to-suggestion' and method == 'POST':
                    try:
                        reh_id = int(parts[3])
                    except ValueError:
                        return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
                    return self.api_move_rehearsal_to_suggestion_id(reh_id)
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            # Performances
            if path.startswith('/api/performances'):
                parts = path.split('/')
                if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
                    if method == 'GET':
                        return self.api_get_performances()
                    if method == 'POST':
                        return self.api_create_performance(body, user)
                    raise NotImplementedError
                if len(parts) == 4:
                    try:
                        perf_id = int(parts[3])
                    except ValueError:
                        return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
                    if method == 'PUT':
                        return self.api_update_performance_id(perf_id, body, user)
                    if method == 'DELETE':
                        return self.api_delete_performance_id(perf_id, user)
                    else:
                        raise NotImplementedError
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            # Settings
            if path == '/api/settings':
                if method == 'GET':
                    return self.api_get_settings()
                if method == 'PUT':
                    return self.api_update_settings(body, user)
                raise NotImplementedError

            # Logs
            if path == '/api/logs':
                if not user or user.get('role') != 'admin':
                    raise PermissionError
                if method == 'GET':
                    return self.api_get_logs()
                raise NotImplementedError

            # Users management (admin only)
            if path.startswith('/api/users'):
                # Ensure user is authenticated and admin
                if not user or user.get('role') != 'admin':
                    raise PermissionError
                parts = path.split('/')
                # GET /api/users
                if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
                    if method == 'GET':
                        return self.api_get_users()
                    raise NotImplementedError
                # PUT /api/users/{id}
                if len(parts) == 4:
                    try:
                        uid = int(parts[3])
                    except ValueError:
                        return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid user id'})
                    if method == 'PUT':
                        return self.api_update_user_id(uid, body, user)
                    else:
                        raise NotImplementedError
                self.send_error(HTTPStatus.NOT_FOUND)
                return

            # Unknown path
            self.send_error(HTTPStatus.NOT_FOUND)
        except PermissionError:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
        except NotImplementedError:
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        except Exception as exc:
            # Log the error on server side and return 500
            print(f"Internal server error: {exc}")
            send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {'error': 'Internal server error'})

    #############################
    # API endpoint handlers
    #############################

    def api_register(self, body: dict):
        username = (body.get('username') or '').strip()
        # Normalize the username to lower‑case to avoid duplicate accounts
        # differing only by case.  Trimming is performed above.
        username = username.lower()
        password = body.get('password') or ''
        if not username or not password:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Username and password are required'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        # Check if a user already exists (case‑insensitive)
        cur.execute('SELECT id FROM users WHERE LOWER(username) = LOWER(?)', (username,))
        if cur.fetchone():
            conn.close()
            send_json(self, HTTPStatus.CONFLICT, {'error': 'User already exists'})
            return
        # Determine if this is the first user; if so, assign admin role
        cur.execute('SELECT COUNT(*) FROM users')
        count = cur.fetchone()[0]
        role = 'admin' if count == 0 else 'user'
        salt, pwd_hash = hash_password(password)
        cur.execute(
            'INSERT INTO users (username, salt, password_hash, role) VALUES (?, ?, ?, ?)',
            (username, salt, pwd_hash, role)
        )
        user_id = cur.lastrowid
        # Add the new user to the default group (id 1)
        cur.execute(
            'INSERT OR IGNORE INTO memberships (user_id, group_id, role, active) VALUES (?, 1, ?, 1)',
            (user_id, role),
        )
        conn.commit()
        conn.close()
        group_id = 1
        # Automatically log in the new user and return a session cookie so the
        # behaviour mirrors the Express implementation.
        token = generate_session(user_id, group_id)
        expires_ts = int(time.time()) + 7 * 24 * 3600
        send_json(
            self,
            HTTPStatus.OK,
            {'id': user_id, 'username': username, 'role': role},
            cookies=[('session_id', token, {'expires': expires_ts, 'path': '/', 'samesite': 'Lax', 'httponly': True})]
        )

    def api_login(self, body: dict):
        username = (body.get('username') or '').strip().lower()
        password = body.get('password') or ''
        if not username or not password:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Username and password are required'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        # Perform a case‑insensitive lookup for the username
        cur.execute('SELECT id, username, salt, password_hash, role FROM users WHERE LOWER(username) = LOWER(?)', (username,))
        row = cur.fetchone()
        conn.close()
        if not row:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Invalid credentials'})
            return
        salt = row['salt']
        pwd_hash = row['password_hash']
        if not verify_password(password, salt, pwd_hash):
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Invalid credentials'})
            return
        # Generate session; row['id'] holds the user's ID.  The row also
        # contains the canonical username from the database, which may
        # differ in case from the input.  We return this canonical
        # username in the response so the client uses a consistent
        # representation.
        # Determine the first group this user belongs to
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT group_id FROM memberships WHERE user_id = ? AND active = 1 ORDER BY group_id LIMIT 1', (row['id'],))
        g_row = cur.fetchone()
        conn.close()
        group_id = g_row['group_id'] if g_row else None
        token = generate_session(row['id'], group_id)
        expires_ts = int(time.time()) + 7 * 24 * 3600
        log_event(row['id'], 'login', {'username': row['username']})
        send_json(
            self,
            HTTPStatus.OK,
            {
                'message': 'Logged in',
                'user': {
                    'id': row['id'],
                    'username': row['username'],
                    'role': row['role'],
                    'isAdmin': row['role'] == 'admin',
                },
            },
            cookies=[('session_id', token, {'expires': expires_ts, 'path': '/', 'samesite': 'Lax', 'httponly': True})]
        )

    def api_logout(self, session_token: str):
        if session_token:
            delete_session(session_token)
        # Clear cookie by setting expiration in the past
        past_ts = int(time.time()) - 3600
        send_json(
            self,
            HTTPStatus.OK,
            {'message': 'Logged out'},
            cookies=[('session_id', '', {'expires': past_ts, 'path': '/', 'samesite': 'Lax', 'httponly': True})]
        )

    def api_me(self, user: dict | None):
        if not user:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
            return
        send_json(self, HTTPStatus.OK, {
            'id': user['id'],
            'username': user['username'],
            'role': user.get('role'),
            'isAdmin': user.get('role') == 'admin',
        })

    def api_get_context(self, user: dict):
        """Return the currently active group for the session."""
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT id, name FROM groups WHERE id = ?', (user['group_id'],))
        row = cur.fetchone()
        conn.close()
        if not row:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Group not found'})
            return
        send_json(self, HTTPStatus.OK, {'id': row['id'], 'name': row['name']})

    def api_set_context(self, body: dict, user: dict, session_token: str):
        """Switch the active group if the user is a member of it."""
        group_id = body.get('groupId')
        if group_id is None:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'groupId is required'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ? AND active = 1',
            (user['id'], group_id)
        )
        if not cur.fetchone():
            conn.close()
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'No membership'})
            return
        cur.execute('UPDATE sessions SET group_id = ? WHERE token = ?', (group_id, session_token))
        cur.execute('SELECT id, name FROM groups WHERE id = ?', (group_id,))
        row = cur.fetchone()
        conn.commit()
        conn.close()
        if not row:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Group not found'})
            return
        send_json(self, HTTPStatus.OK, {'id': row['id'], 'name': row['name']})

    def api_create_group(self, body: dict, user: dict):
        name = (body.get('name') or '').strip()
        description = (body.get('description') or '').strip() or None
        logo_url = (body.get('logoUrl') or '').strip() or None
        if not name:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'name is required'})
            return
        code = generate_unique_invitation_code()
        group_id = create_group(name, code, description, logo_url, user['id'])
        create_membership(user['id'], group_id, 'admin', None)
        send_json(self, HTTPStatus.CREATED, {'id': group_id, 'invitationCode': code})

    def api_join_group(self, body: dict, user: dict):
        code = (body.get('code') or '').strip()
        nickname = (body.get('nickname') or '').strip() or None
        if not code:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'code is required'})
            return
        group = get_group_by_code(code)
        if not group:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Invalid code'})
            return
        if get_membership(user['id'], group['id']):
            send_json(self, HTTPStatus.CONFLICT, {'error': 'Already a member'})
            return
        create_membership(user['id'], group['id'], 'user', nickname)
        send_json(self, HTTPStatus.CREATED, {'groupId': group['id']})

    def api_renew_group_code(self, user: dict):
        membership = get_membership(user['id'], user['group_id'])
        if not membership or membership['role'] != 'admin':
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        new_code = generate_unique_invitation_code()
        update_group_code(user['group_id'], new_code)
        send_json(self, HTTPStatus.OK, {'invitationCode': new_code})

    def api_get_suggestions(self):
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.likes, s.creator_id, s.created_at, u.username AS creator
               FROM suggestions s
               JOIN users u ON u.id = s.creator_id
               ORDER BY s.likes DESC, s.created_at ASC'''
        )
        rows = [dict(row) for row in cur.fetchall()]
        conn.close()
        # Rename fields to camelCase and include author and youtube
        result = []
        for r in rows:
            entry = {
                'id': r['id'],
                'title': r['title'],
                'author': r['author'],
                'youtube': r['youtube'] or r['url'],
                'creatorId': r['creator_id'],
                'creator': r['creator'],
                'createdAt': r['created_at'],
                'likes': r['likes'],
            }
            result.append(entry)
        send_json(self, HTTPStatus.OK, result)

    def api_create_suggestion(self, body: dict, user: dict):
        title = (body.get('title') or '').strip()
        author = (body.get('author') or '').strip() or None
        youtube = (body.get('youtube') or body.get('url') or '').strip() or None
        if not title:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Title is required'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO suggestions (title, author, youtube, url, creator_id) VALUES (?, ?, ?, ?, ?)',
            (title, author, youtube, youtube, user['id'])
        )
        suggestion_id = cur.lastrowid
        # Retrieve the created row with creator username and timestamp
        cur.execute(
            '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.likes,
                     s.creator_id, s.created_at, u.username AS creator
               FROM suggestions s JOIN users u ON u.id = s.creator_id
               WHERE s.id = ?''',
            (suggestion_id,)
        )
        row = cur.fetchone()
        conn.commit()
        conn.close()
        if row:
            result = {
                'id': row['id'],
                'title': row['title'],
                'author': row['author'],
                'youtube': row['youtube'] or row['url'],
                'creatorId': row['creator_id'],
                'creator': row['creator'],
                'createdAt': row['created_at'],
                'likes': row['likes'],
            }
            send_json(self, HTTPStatus.CREATED, result)
        else:
            send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {'error': 'Failed to fetch created suggestion'})

    def api_delete_suggestion(self, body: dict, user: dict):
        """Delete a suggestion using a JSON body.  The body should contain
        an ``id`` field specifying the suggestion to delete.  Deletion
        is permitted for the suggestion's creator or for an admin user."""
        try:
            sug_id = int(body.get('id'))
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid suggestion id'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        if user.get('role') in ('admin', 'moderator'):
            cur.execute('DELETE FROM suggestions WHERE id = ?', (sug_id,))
        else:
            cur.execute('DELETE FROM suggestions WHERE id = ? AND creator_id = ?', (sug_id, user['id']))
        deleted = cur.rowcount
        conn.commit()
        conn.close()
        if deleted:
            log_event(user['id'], 'delete', {'entity': 'suggestion', 'id': sug_id})
            send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found or not owned'})

    def api_update_suggestion(self, body: dict, user: dict):
        """Backward-compatible endpoint for updating a suggestion.
        The body must include ``id`` and ``title`` fields."""
        try:
            sug_id = int(body.get('id'))
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid suggestion id'})
            return
        return self.api_update_suggestion_id(sug_id, body, user)

    def api_get_rehearsals(self):
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            '''SELECT r.id, r.title, r.author, r.youtube, r.spotify, r.audio_notes_json, r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at, u.username AS creator
               FROM rehearsals r JOIN users u ON u.id = r.creator_id ORDER BY r.created_at ASC'''
        )
        rows = []
        for row in cur.fetchall():
            levels = json.loads(row['levels_json'] or '{}')
            notes = json.loads(row['notes_json'] or '{}')
            audio_notes = json.loads(row['audio_notes_json'] or '{}')
            rows.append({
                'id': row['id'],
                'title': row['title'],
                'author': row['author'],
                'youtube': row['youtube'],
                'spotify': row['spotify'],
                'audioNotes': audio_notes,
                'levels': levels,
                'notes': notes,
                'mastered': bool(row['mastered']),
                'creatorId': row['creator_id'],
                'creator': row['creator'],
                'createdAt': row['created_at'],
            })
        conn.close()
        send_json(self, HTTPStatus.OK, rows)

    def api_create_rehearsal(self, body: dict, user: dict):
        title = (body.get('title') or '').strip()
        author = (body.get('author') or '').strip() or None
        youtube = (body.get('youtube') or '').strip() or None
        spotify = (body.get('spotify') or '').strip() or None
        if not title:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Title is required'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO rehearsals (title, author, youtube, spotify, levels_json, notes_json, audio_notes_json, mastered, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (title, author, youtube, spotify, json.dumps({}), json.dumps({}), json.dumps({}), 0, user['id'])
        )
        rehearsal_id = cur.lastrowid
        conn.commit()
        conn.close()
        send_json(self, HTTPStatus.CREATED, {'id': rehearsal_id, 'title': title, 'author': author, 'youtube': youtube, 'spotify': spotify, 'mastered': False})

    def api_update_rehearsal(self, body: dict, user: dict):
        """Backward‑compatible endpoint for updating a rehearsal.  The
        incoming body must contain an ``id`` field and may include
        ``level``, ``note``, ``title``, ``youtube`` or ``spotify``.
        Delegates to ``api_update_rehearsal_id`` for the actual logic."""
        try:
            rehearsal_id = int(body.get('id'))
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid rehearsal id'})
            return
        return self.api_update_rehearsal_id(rehearsal_id, body, user)

    def api_get_performances(self):
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            '''SELECT p.id, p.name, p.date, p.songs_json, p.creator_id, u.username AS creator
               FROM performances p JOIN users u ON u.id = p.creator_id ORDER BY p.date ASC'''
        )
        result = []
        for row in cur.fetchall():
            result.append({
                'id': row['id'],
                'name': row['name'],
                'date': row['date'],
                'songs': json.loads(row['songs_json'] or '[]'),
                'creatorId': row['creator_id'],
                'creator': row['creator'],
            })
        conn.close()
        # Return the list directly to align with the Express API
        send_json(self, HTTPStatus.OK, result)

    def api_create_performance(self, body: dict, user: dict):
        name = (body.get('name') or '').strip()
        date = (body.get('date') or '').strip()
        songs = body.get('songs') or []
        if not name or not date:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
            return
        # Validate songs: ensure list of ints
        try:
            songs_list = [int(s) for s in songs]
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'INSERT INTO performances (name, date, songs_json, creator_id) VALUES (?, ?, ?, ?)',
            (name, date, json.dumps(songs_list), user['id'])
        )
        perf_id = cur.lastrowid
        conn.commit()
        conn.close()
        send_json(self, HTTPStatus.CREATED, {'id': perf_id, 'name': name, 'date': date, 'songs': songs_list})

    def api_update_performance(self, body: dict, user: dict):
        try:
            perf_id = int(body.get('id'))
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid performance id'})
            return
        name = (body.get('name') or '').strip()
        date = (body.get('date') or '').strip()
        songs = body.get('songs') or []
        if not name or not date:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
            return
        try:
            songs_list = [int(s) for s in songs]
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        # Allow update if current user is creator or has moderator/administrator role
        if user.get('role') in ('admin', 'moderator'):
            cur.execute(
                'UPDATE performances SET name = ?, date = ?, songs_json = ? WHERE id = ?',
                (name, date, json.dumps(songs_list), perf_id)
            )
        else:
            cur.execute(
                'UPDATE performances SET name = ?, date = ?, songs_json = ? WHERE id = ? AND creator_id = ?',
                (name, date, json.dumps(songs_list), perf_id, user['id'])
            )
        updated = cur.rowcount
        conn.commit()
        conn.close()
        if updated:
            log_event(user['id'], 'edit', {'entity': 'performance', 'id': perf_id})
            send_json(self, HTTPStatus.OK, {'message': 'Updated'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Performance not found or not owned'})

    # ------------------------------------------------------------------
    # Helper methods to support REST paths with IDs (e.g. /api/suggestions/1)
    # The following functions are wrappers around the body‑based methods
    # above, allowing the id to be passed as a separate argument.  They
    # match the signatures used when parsing dynamic segments in
    # ``handle_api_request``.

    def api_delete_suggestion_id(self, sug_id: int, user: dict):
        """Delete a suggestion by ID.  The suggestion can be removed by its
        creator or by an administrator.  Returns 404 if the suggestion
        does not exist or the user lacks the necessary privileges."""
        conn = get_db_connection()
        cur = conn.cursor()
        # Allow deletion if the user is the creator OR has moderator/administrator role
        if user.get('role') in ('admin', 'moderator'):
            cur.execute('DELETE FROM suggestions WHERE id = ?', (sug_id,))
        else:
            cur.execute('DELETE FROM suggestions WHERE id = ? AND creator_id = ?', (sug_id, user['id']))
        deleted = cur.rowcount
        conn.commit()
        conn.close()
        if deleted:
            send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found or not owned'})

    def api_vote_suggestion_id(self, sug_id: int, user: dict):
        """Increment likes for a suggestion and return the updated row."""
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('UPDATE suggestions SET likes = likes + 1 WHERE id = ?', (sug_id,))
        if cur.rowcount == 0:
            conn.commit()
            conn.close()
            return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})
        cur.execute(
            '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.likes, s.creator_id, s.created_at,
                      u.username AS creator FROM suggestions s JOIN users u ON u.id = s.creator_id
               WHERE s.id = ?''',
            (sug_id,)
        )
        row = cur.fetchone()
        conn.commit()
        conn.close()
        if row:
            result = {
                'id': row['id'],
                'title': row['title'],
                'author': row['author'],
                'youtube': row['youtube'] or row['url'],
                'creatorId': row['creator_id'],
                'creator': row['creator'],
                'createdAt': row['created_at'],
                'likes': row['likes'],
            }
            log_event(user['id'], 'vote', {'suggestionId': sug_id})
            send_json(self, HTTPStatus.OK, result)
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})

    def api_unvote_suggestion_id(self, sug_id: int, user: dict):
        """Decrement likes for a suggestion and return the updated row."""
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'UPDATE suggestions '
            'SET likes = CASE WHEN likes > 0 THEN likes - 1 ELSE 0 END '
            'WHERE id = ?',
            (sug_id,)
        )
        if cur.rowcount == 0:
            conn.commit()
            conn.close()
            return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})
        cur.execute(
            '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.likes, s.creator_id, s.created_at,
                      u.username AS creator FROM suggestions s JOIN users u ON u.id = s.creator_id
               WHERE s.id = ?''',
            (sug_id,)
        )
        row = cur.fetchone()
        conn.commit()
        conn.close()
        if row:
            result = {
                'id': row['id'],
                'title': row['title'],
                'author': row['author'],
                'youtube': row['youtube'] or row['url'],
                'creatorId': row['creator_id'],
                'creator': row['creator'],
                'createdAt': row['created_at'],
                'likes': row['likes'],
            }
            log_event(user['id'], 'unvote', {'suggestionId': sug_id})
            send_json(self, HTTPStatus.OK, result)
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})

    def api_update_suggestion_id(self, sug_id: int, body: dict, user: dict):
        """Update a suggestion's title and optional fields by ID."""
        title = (body.get('title') or '').strip()
        author = (body.get('author') or '').strip() or None
        youtube = (body.get('youtube') or body.get('url') or '').strip() or None
        if not title:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Title is required'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        if user.get('role') in ('admin', 'moderator'):
            cur.execute(
                'UPDATE suggestions SET title = ?, author = ?, youtube = ?, url = ? WHERE id = ?',
                (title, author, youtube, youtube, sug_id),
            )
        else:
            cur.execute(
                'UPDATE suggestions SET title = ?, author = ?, youtube = ?, url = ? WHERE id = ? AND creator_id = ?',
                (title, author, youtube, youtube, sug_id, user['id']),
            )
        updated = cur.rowcount
        if updated:
            conn.commit()
            conn.close()
            log_event(user['id'], 'edit', {'entity': 'suggestion', 'id': sug_id})
            send_json(self, HTTPStatus.OK, {'message': 'Updated'})
        else:
            # Determine if the suggestion exists
            cur.execute('SELECT 1 FROM suggestions WHERE id = ?', (sug_id,))
            exists = cur.fetchone()
            conn.commit()
            conn.close()
            if exists:
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not allowed'})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})

    def api_update_rehearsal_id(self, rehearsal_id: int, body: dict, user: dict):
        """Update a rehearsal by ID.  This method handles two scenarios:

        * Updating the current user's level and/or note for the rehearsal
          (fields ``level`` and ``note`` in the body).  This is allowed
          for any authenticated user.
        * Editing the rehearsal's metadata (fields ``title``, ``youtube``
          and ``spotify``).  This is only permitted if the requester is
          the creator of the rehearsal or an administrator.

        Both operations may be combined in a single request.  If no
        updatable fields are provided, a 400 response is returned.
        """
        # Determine which fields are being updated
        title = body.get('title')
        author = body.get('author')
        youtube = body.get('youtube')
        spotify = body.get('spotify')
        level = body.get('level')
        note = body.get('note')
        audio_b64 = body.get('audio')
        # If nothing to update, return error
        if all(v is None for v in (title, author, youtube, spotify, level, note, audio_b64)):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Nothing to update'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        # Fetch current rehearsal record including author and audio notes JSON
        cur.execute(
            'SELECT title, author, youtube, spotify, levels_json, notes_json, audio_notes_json, mastered, creator_id '
            'FROM rehearsals WHERE id = ?',
            (rehearsal_id,)
        )
        row = cur.fetchone()
        if not row:
            conn.close()
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
            return
        # Prepare modifications
        updated_metadata = False
        # Check if we need to update metadata
        if any(v is not None for v in (title, author, youtube, spotify)):
            # Only creator, moderator or admin can modify metadata
            if not (user.get('role') in ('admin', 'moderator') or user['id'] == row['creator_id']):
                conn.close()
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not allowed to edit rehearsal details'})
                return
            # Use current values if None provided
            new_title = (title or row['title']).strip() if title is not None else row['title']
            new_author = (author or '').strip() if author is not None else row['author']
            new_author = new_author or None
            new_youtube = (youtube or '').strip() if youtube is not None else row['youtube']
            new_youtube = new_youtube or None
            new_spotify = (spotify or '').strip() if spotify is not None else row['spotify']
            new_spotify = new_spotify or None
            # Update the row
            cur.execute(
                'UPDATE rehearsals SET title = ?, author = ?, youtube = ?, spotify = ? WHERE id = ?',
                (new_title, new_author, new_youtube, new_spotify, rehearsal_id)
            )
            updated_metadata = cur.rowcount > 0
        # Update level/note/audio if provided
        updated_levels_notes_audio = False
        if level is not None or note is not None or audio_b64 is not None:
            # Parse JSON fields
            levels = json.loads(row['levels_json'] or '{}')
            notes = json.loads(row['notes_json'] or '{}')
            audio_notes = json.loads(row['audio_notes_json'] or '{}')
            if level is not None:
                try:
                    level_val = float(level)
                except (TypeError, ValueError):
                    conn.close()
                    send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid level'})
                    return
                levels[user['username']] = max(0, min(10, level_val))
            if note is not None:
                notes[user['username']] = str(note)
            if audio_b64 is not None:
                # Accept empty string to clear audio
                if audio_b64 == '':
                    if user['username'] in audio_notes:
                        audio_notes.pop(user['username'], None)
                else:
                    audio_notes[user['username']] = str(audio_b64)
            cur.execute(
                'UPDATE rehearsals SET levels_json = ?, notes_json = ?, audio_notes_json = ? WHERE id = ?',
                (json.dumps(levels), json.dumps(notes), json.dumps(audio_notes), rehearsal_id)
            )
            updated_levels_notes_audio = cur.rowcount > 0
        conn.commit()
        conn.close()
        if updated_metadata or updated_levels_notes_audio:
            log_event(user['id'], 'edit', {'entity': 'rehearsal', 'id': rehearsal_id})
            send_json(self, HTTPStatus.OK, {'message': 'Updated'})
        else:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Nothing was updated'})

    def api_toggle_rehearsal_mastered(self, rehearsal_id: int, user: dict):
        """Toggle the mastered flag for a rehearsal."""
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT mastered, creator_id FROM rehearsals WHERE id = ?', (rehearsal_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
        if not (user.get('role') in ('admin', 'moderator') or user['id'] == row['creator_id']):
            conn.close()
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not allowed to edit rehearsal'})
        new_val = 0 if row['mastered'] else 1
        cur.execute('UPDATE rehearsals SET mastered = ? WHERE id = ?', (new_val, rehearsal_id))
        conn.commit()
        cur.execute(
            '''SELECT r.id, r.title, r.author, r.youtube, r.spotify, r.audio_notes_json,
                      r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at,
                      u.username AS creator FROM rehearsals r JOIN users u ON u.id = r.creator_id
               WHERE r.id = ?''',
            (rehearsal_id,)
        )
        updated = cur.fetchone()
        conn.close()
        if updated:
            levels = json.loads(updated['levels_json'] or '{}')
            notes = json.loads(updated['notes_json'] or '{}')
            audio_notes = json.loads(updated['audio_notes_json'] or '{}')
            send_json(
                self,
                HTTPStatus.OK,
                {
                    'id': updated['id'],
                    'title': updated['title'],
                    'author': updated['author'],
                    'youtube': updated['youtube'],
                    'spotify': updated['spotify'],
                    'audioNotes': audio_notes,
                    'levels': levels,
                    'notes': notes,
                    'mastered': bool(updated['mastered']),
                    'creatorId': updated['creator_id'],
                    'creator': updated['creator'],
                    'createdAt': updated['created_at'],
                },
            )
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})

    def api_move_suggestion_to_rehearsal_id(self, sug_id: int):
        """Move a suggestion to rehearsals."""
        result = move_suggestion_to_rehearsal(sug_id)
        if result is None:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})
        else:
            send_json(self, HTTPStatus.OK, result)

    def api_move_rehearsal_to_suggestion_id(self, reh_id: int):
        """Move a rehearsal back to suggestions."""
        result = move_rehearsal_to_suggestion(reh_id)
        if result is None:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
        else:
            send_json(self, HTTPStatus.OK, result)

    def api_update_performance_id(self, perf_id: int, body: dict, user: dict):
        """Update name, date and songs for a performance if owned by user."""
        name = (body.get('name') or '').strip()
        date = (body.get('date') or '').strip()
        songs = body.get('songs') or []
        if not name or not date:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
            return
        try:
            songs_list = [int(s) for s in songs]
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        # Allow update if user is creator or has moderator/administrator role
        if user.get('role') in ('admin', 'moderator'):
            cur.execute(
                'UPDATE performances SET name = ?, date = ?, songs_json = ? WHERE id = ?',
                (name, date, json.dumps(songs_list), perf_id)
            )
        else:
            cur.execute(
                'UPDATE performances SET name = ?, date = ?, songs_json = ? WHERE id = ? AND creator_id = ?',
                (name, date, json.dumps(songs_list), perf_id, user['id'])
            )
        updated = cur.rowcount
        conn.commit()
        conn.close()
        if updated:
            send_json(self, HTTPStatus.OK, {'message': 'Updated'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Performance not found or not owned'})

    def api_delete_performance_id(self, perf_id: int, user: dict):
        """Delete a performance by ID.  The performance can be removed by its
        creator or by an administrator."""
        conn = get_db_connection()
        cur = conn.cursor()
        if user.get('role') in ('admin', 'moderator'):
            cur.execute('DELETE FROM performances WHERE id = ?', (perf_id,))
        else:
            cur.execute('DELETE FROM performances WHERE id = ? AND creator_id = ?', (perf_id, user['id']))
        deleted = cur.rowcount
        conn.commit()
        conn.close()
        if deleted:
            log_event(user['id'], 'delete', {'entity': 'performance', 'id': perf_id})
            send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Performance not found or not owned'})

    def api_delete_rehearsal_id(self, rehearsal_id: int, user: dict):
        """Delete a rehearsal by ID.  The rehearsal may be removed by its
        creator or by an admin.  When a rehearsal is deleted, any
        performances referencing it will have the rehearsal ID removed
        from their song lists.  If no performances contain the ID, no
        changes occur.  If the user lacks permission or the rehearsal
        does not exist, a 404 is returned."""
        conn = get_db_connection()
        cur = conn.cursor()
        # Fetch creator_id to check permissions
        cur.execute('SELECT creator_id FROM rehearsals WHERE id = ?', (rehearsal_id,))
        row = cur.fetchone()
        if not row:
            conn.close()
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
            return
        creator_id = row['creator_id']
        if not (user.get('role') in ('admin', 'moderator') or user['id'] == creator_id):
            conn.close()
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not allowed to delete rehearsal'})
            return
        # Remove the rehearsal ID from all performances
        cur.execute('SELECT id, songs_json FROM performances')
        performances_to_update = []
        for perf in cur.fetchall():
            songs = json.loads(perf['songs_json'] or '[]')
            if rehearsal_id in songs:
                songs = [sid for sid in songs if sid != rehearsal_id]
                performances_to_update.append((json.dumps(songs), perf['id']))
        for songs_json, perf_id in performances_to_update:
            cur.execute('UPDATE performances SET songs_json = ? WHERE id = ?', (songs_json, perf_id))
        # Now delete the rehearsal itself
        cur.execute('DELETE FROM rehearsals WHERE id = ?', (rehearsal_id,))
        deleted = cur.rowcount
        conn.commit()
        conn.close()
        if deleted:
            log_event(user['id'], 'delete', {'entity': 'rehearsal', 'id': rehearsal_id})
            send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found or not owned'})

    def api_delete_performance(self, body: dict, user: dict):
        try:
            perf_id = int(body.get('id'))
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid performance id'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            'DELETE FROM performances WHERE id = ? AND creator_id = ?',
            (perf_id, user['id'])
        )
        deleted = cur.rowcount
        conn.commit()
        conn.close()
        if deleted:
            log_event(user['id'], 'delete', {'entity': 'performance', 'id': perf_id})
            send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Performance not found or not owned'})

    def api_get_logs(self):
        """Return recent log entries."""
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute(
            '''SELECT l.id, l.timestamp, l.user_id, u.username, l.action, l.metadata
               FROM logs l LEFT JOIN users u ON u.id = l.user_id
               ORDER BY l.timestamp DESC LIMIT 100'''
        )
        rows = []
        for row in cur.fetchall():
            rows.append({
                'id': row['id'],
                'timestamp': row['timestamp'],
                'userId': row['user_id'],
                'username': row['username'],
                'action': row['action'],
                'metadata': json.loads(row['metadata'] or '{}'),
            })
        conn.close()
        send_json(self, HTTPStatus.OK, rows)

    def api_get_settings(self):
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT group_name, dark_mode, template, next_rehearsal_date, next_rehearsal_location FROM settings WHERE id = 1')
        row = cur.fetchone()
        conn.close()
        if not row:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Settings not found'})
            return
        send_json(self, HTTPStatus.OK, {
            'groupName': row['group_name'],
            'darkMode': bool(row['dark_mode']),
            'template': row['template'] or 'classic',
            'nextRehearsalDate': row['next_rehearsal_date'] or '',
            'nextRehearsalLocation': row['next_rehearsal_location'] or ''
        })

    def api_update_settings(self, body: dict, user: dict):
        group_name = (body.get('groupName') or '').strip()
        dark_mode = body.get('darkMode')
        template = body.get('template')
        next_date = (body.get('nextRehearsalDate') or '').strip()
        next_loc = (body.get('nextRehearsalLocation') or '').strip()
        if not group_name or dark_mode is None:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'groupName and darkMode are required'})
            return
        # If template is provided, ensure it is a non-empty string
        if template is not None:
            template = (str(template).strip() or 'classic')
        conn = get_db_connection()
        cur = conn.cursor()
        if template is None:
            cur.execute(
                'UPDATE settings SET group_name = ?, dark_mode = ?, next_rehearsal_date = ?, next_rehearsal_location = ? WHERE id = 1',
                (group_name, 1 if bool(dark_mode) else 0, next_date, next_loc)
            )
        else:
            cur.execute(
                'UPDATE settings SET group_name = ?, dark_mode = ?, template = ?, next_rehearsal_date = ?, next_rehearsal_location = ? WHERE id = 1',
                (group_name, 1 if bool(dark_mode) else 0, template, next_date, next_loc)
            )
        conn.commit()
        conn.close()
        send_json(self, HTTPStatus.OK, {'message': 'Settings updated'})

    # ------------------------------------------------------------------
    # Users management (admin only)

    def api_get_users(self):
        """Return a list of all users with their admin status.  Accessible
        only to administrators."""
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('SELECT id, username, role FROM users ORDER BY username ASC')
        users = []
        for row in cur.fetchall():
            users.append({
                'id': row['id'],
                'username': row['username'],
                'role': row['role'],
            })
        conn.close()
        send_json(self, HTTPStatus.OK, users)

    def api_update_user_id(self, uid: int, body: dict, current_user: dict):
        """Update a user's role.  Only administrators can call this
        endpoint.  The body should contain ``role`` (user, moderator or
        admin).  Administrators cannot demote themselves to avoid
        accidental lockouts."""
        role = body.get('role')
        if role not in ('user', 'moderator', 'admin'):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid role'})
            return
        if uid == current_user['id'] and role != 'admin':
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Cannot change your own admin role'})
            return
        conn = get_db_connection()
        cur = conn.cursor()
        cur.execute('UPDATE users SET role = ? WHERE id = ?', (role, uid))
        updated = cur.rowcount
        conn.commit()
        conn.close()
        if updated:
            log_event(current_user['id'], 'role_change', {'targetUserId': uid, 'newRole': role})
            send_json(self, HTTPStatus.OK, {'message': 'User updated'})
        else:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'User not found'})

#############################
# Server entry point
#############################

def run_server(host: str = '0.0.0.0', port: int = 3000):
    init_db()
    server = ThreadingHTTPServer((host, port), BandTrackHandler)
    print(f"BandTrack server running on http://{host}:{port} (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run BandTrack backend server.')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', 3000)), help='Port to bind the server on')
    parser.add_argument('--host', type=str, default=os.environ.get('HOST', '0.0.0.0'), help='Host/IP to bind the server on')
    args = parser.parse_args()
    run_server(args.host, args.port)
