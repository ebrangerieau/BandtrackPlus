#!/usr/bin/env python3
"""
bandtrack.api
=============

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
  database (`bandtrack.db`) with the same structure as an earlier
  Node/Express prototype, which has since been retired.
* A single settings row stores the group name and dark mode flag, which
  are applied at load time for all users.
* The API endpoints mirror those used by the frontend so that the
  existing JavaScript code (in ``public/js/ui/index.js``) can remain largely
  unchanged.  The only notable difference is that cookie names and
  expiration behaviour are handled here.
* Static files are served from the ``public`` directory for any path
  outside of ``/api``.  Unknown paths fall back to ``index.html`` to
  support client‑side routing in the SPA.

Usage
-----

Running the server is as simple as executing ``main.py`` with Python:

```
python3 main.py
```

The server listens on port 8080 by default.  You can override the port
by setting the ``PORT`` environment variable or passing ``--port`` on
the command line.  Example:

```
python3 main.py --port 5000
```

The server automatically creates the database and tables on first run,
and inserts a default settings row if none exists.  Data persists in
``bandtrack.db`` across restarts.

Note: Because this server runs on the same domain as the frontend, no
CORS headers are necessary.  The session cookie is marked ``HttpOnly``
with ``SameSite=None``.  The ``Secure`` flag is added only when the
request is served over HTTPS (detected via standard proxy headers),
unless forced by the ``SESSION_COOKIE_SECURE`` environment variable.
HTTPS termination should be handled by an upstream proxy in production.
"""

import argparse
import json
import os
import sqlite3
import logging
import time
try:
    import psycopg2  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    psycopg2 = None  # type: ignore
import datetime
import gzip
import urllib.parse
import mimetypes
import io
import asyncio
import threading
import hmac
import secrets
import string
import re
from http import HTTPStatus
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
try:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
except ImportError:  # pragma: no cover - optional dependency
    canvas = None
    A4 = None
try:
    import websockets  # type: ignore
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    websockets = None  # type: ignore

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from bandtrack.db import (
    get_db_connection,
    open_db_connection,
    execute_write,
    safe_commit,
    PartitionDAO,
    get_partition_dao,
    init_db,
    _using_postgres,
    Psycopg2Error,
)
from bandtrack.auth import (
    hash_password,
    verify_password,
    generate_invitation_code,
    generate_unique_invitation_code,
    generate_session,
    get_user_by_session,
    delete_session,
    log_event,
)
from bandtrack.utils import sanitize_name, scan_for_viruses, parse_multipart_form_data

# Path for uploaded partition files
UPLOADS_ROOT = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'uploads', 'partitions')

# Maximum allowed size for uploaded partition files (default 5 MB)
MAX_PARTITION_SIZE = int(os.environ.get('MAX_PARTITION_SIZE', 5 * 1024 * 1024))

# Maximum allowed size for HTTP request bodies (default 1 MB)
MAX_REQUEST_SIZE = int(os.environ.get('MAX_REQUEST_SIZE', 1 * 1024 * 1024))

# Force the ``Secure`` flag on session cookies even if the request is not
# detected as HTTPS.  By default the flag is only added when HTTPS is detected
# via ``X-Forwarded-Proto`` or ``Forwarded`` headers.  Set
# ``SESSION_COOKIE_SECURE=1`` to always include the flag.
SESSION_COOKIE_SECURE = os.environ.get('SESSION_COOKIE_SECURE', '').lower() in (
    '1', 'true', 'yes'
)

# WebSocket server state
WS_CLIENTS: set = set()
WS_LOOP: asyncio.AbstractEventLoop | None = None


def request_is_https(handler: BaseHTTPRequestHandler) -> bool:
    """Return True if the current request was made via HTTPS.

    Detection relies on standard proxy headers such as ``X-Forwarded-Proto``
    or ``Forwarded``.  If neither header is present, the request is assumed to
    be plain HTTP."""

    proto = handler.headers.get('X-Forwarded-Proto')
    if proto:
        return proto.lower() == 'https'
    forwarded = handler.headers.get('Forwarded')
    if forwarded:
        m = re.search(r'proto=([^;]+)', forwarded, re.IGNORECASE)
        if m and m.group(1).lower() == 'https':
            return True
    return False


def cookie_secure(handler: BaseHTTPRequestHandler) -> bool:
    """Return True if session cookies should include the ``Secure`` flag."""

    return SESSION_COOKIE_SECURE or request_is_https(handler)


async def ws_handler(websocket):
    WS_CLIENTS.add(websocket)
    try:
        await websocket.wait_closed()
    finally:
        WS_CLIENTS.discard(websocket)


def broadcast_ws(event: dict) -> None:
    if websockets is None or not WS_CLIENTS:
        return
    if WS_LOOP is None:
        print("Warning: WebSocket loop is not running; skipping broadcast")
        return
    if not WS_LOOP.is_running():
        return
    message = json.dumps(event)
    for ws in list(WS_CLIENTS):
        try:
            asyncio.run_coroutine_threadsafe(ws.send(message), WS_LOOP)
        except RuntimeError:
            return


def start_ws_server(host: str, http_port: int) -> None:
    if websockets is None:  # pragma: no cover - optional dependency
        return
    ws_url = os.environ.get('WS_URL')
    ws_host = host
    ws_port = http_port + 1
    if ws_url:
        parsed = urllib.parse.urlparse(ws_url)
        if parsed.hostname:
            ws_host = parsed.hostname
        if parsed.port:
            ws_port = parsed.port
    else:
        ws_port = int(os.environ.get('WS_PORT', ws_port))
    global WS_LOOP
    WS_LOOP = asyncio.new_event_loop()
    asyncio.set_event_loop(WS_LOOP)
    server = websockets.serve(ws_handler, ws_host, ws_port)
    WS_LOOP.run_until_complete(server)
    WS_LOOP.run_forever()


def parse_audio_notes_json(data: str | None) -> dict:
    """Return audio notes as a mapping of user to list of notes.

    Each note is represented as ``{"title": str, "audio": str}``.  Older
    representations that stored a single base64 string per user are converted
    to the new list-based structure."""

    raw = json.loads(data or '{}')
    result: dict[str, list[dict]] = {}
    for user, notes in raw.items():
        if isinstance(notes, list):
            parsed_list = []
            for item in notes:
                if isinstance(item, dict):
                    parsed_list.append({
                        'title': item.get('title', ''),
                        'audio': item.get('audio', ''),
                    })
                elif isinstance(item, str):
                    parsed_list.append({'title': '', 'audio': item})
            if parsed_list:
                result[user] = parsed_list
        elif isinstance(notes, str):
            result[user] = [{'title': '', 'audio': notes}]
    return result
def add_webauthn_credential(user_id: int, credential_id: str) -> int:
    """Store a WebAuthn credential for a user."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'INSERT INTO users_webauthn (user_id, credential_id) VALUES (?, ?)',
            (user_id, credential_id),
        )
        cred_id = cur.lastrowid
        safe_commit(conn)
    return cred_id


def get_webauthn_credentials(user_id: int) -> list[str]:
    """Return all credential IDs associated with a user."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 'SELECT credential_id FROM users_webauthn WHERE user_id = ?', (user_id,))
        rows = [row['credential_id'] for row in cur.fetchall()]
    return rows


def get_user_by_webauthn_credential(credential_id: str) -> dict | None:
    """Lookup the user owning a given credential ID."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'SELECT u.id, u.username, u.role, u.last_group_id FROM users_webauthn w JOIN users u ON u.id = w.user_id WHERE w.credential_id = ?',
            (credential_id,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def verify_webauthn_credential(user_id: int, credential_id: str) -> bool:
    """Check that ``credential_id`` belongs to ``user_id``."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 'SELECT credential_id FROM users_webauthn WHERE user_id = ?', (user_id,))
        rows = cur.fetchall()
    for r in rows:
        if hmac.compare_digest(r['credential_id'], credential_id):
            return True
    return False

def read_request_body(handler: BaseHTTPRequestHandler) -> bytes | None:
    """Read and return the request body for the current request.

    Enforces ``MAX_REQUEST_SIZE`` to prevent excessive memory usage.  If the
    ``Content-Length`` header is missing or invalid, empty bytes are returned.
    When the declared length exceeds ``MAX_REQUEST_SIZE`` an HTTP
    ``413 Payload Too Large`` response is sent and ``None`` is returned so the
    caller can abort further processing."""
    try:
        length = int(handler.headers.get('Content-Length', 0))
    except ValueError:
        return b''
    if length > MAX_REQUEST_SIZE:
        send_json(handler, HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {'error': 'Payload too large'})
        return None
    length = min(length, MAX_REQUEST_SIZE)
    return handler.rfile.read(length) if length > 0 else b''

def send_json(handler: BaseHTTPRequestHandler, status: int, data: dict, *, cookies: list[tuple[str, str, dict]] = None) -> None:
    """Serialize ``data`` to JSON and send it in the response with the given
    HTTP status code.  ``cookies`` can be a list of tuples in the form
    ``(name, value, options)`` where options is a dict of cookie
    attributes (expires, path, samesite, httponly, etc.)."""
    payload = json.dumps(data).encode('utf-8')
    accepts = handler.headers.get('Accept-Encoding', '')
    use_gzip = 'gzip' in accepts
    if use_gzip:
        payload = gzip.compress(payload)
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    if use_gzip:
        handler.send_header('Content-Encoding', 'gzip')
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
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'SELECT title, author, youtube, url, version_of, creator_id, group_id FROM suggestions WHERE id = ?',
            (sug_id,)
        )
        row = cur.fetchone()
        if not row:
            return None
        yt = row['youtube'] or row['url']
        execute_write(cur, 
            'INSERT INTO rehearsals (title, author, youtube, spotify, version_of, levels_json, notes_json, audio_notes_json, mastered, creator_id, group_id) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (row['title'], row['author'], yt, None, row['version_of'], json.dumps({}), json.dumps({}), json.dumps({}), 0, row['creator_id'], row['group_id']),
        )
        new_id = cur.lastrowid
        execute_write(cur, 
            '''SELECT r.id, r.title, r.author, r.youtube, r.spotify, r.version_of, r.audio_notes_json,
                      r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at,
                      u.username AS creator FROM rehearsals r JOIN users u ON u.id = r.creator_id
               WHERE r.id = ?''',
            (new_id,),
        )
        new_row = cur.fetchone()
        execute_write(cur, 'DELETE FROM suggestion_votes WHERE suggestion_id = ?', (sug_id,))
        execute_write(cur, 'DELETE FROM suggestions WHERE id = ? AND group_id = ?', (sug_id, row['group_id']))
        safe_commit(conn)
    if not new_row:
        return None
    return {
        'id': new_row['id'],
        'title': new_row['title'],
        'author': new_row['author'],
        'youtube': new_row['youtube'],
        'spotify': new_row['spotify'],
        'versionOf': new_row['version_of'],
        'audioNotes': parse_audio_notes_json(new_row['audio_notes_json']),
        'levels': json.loads(new_row['levels_json'] or '{}'),
        'notes': json.loads(new_row['notes_json'] or '{}'),
        'mastered': bool(new_row['mastered']),
        'creatorId': new_row['creator_id'],
        'creator': new_row['creator'],
        'createdAt': new_row['created_at'],
    }

def move_rehearsal_to_suggestion(reh_id: int):
    """Create a suggestion from a rehearsal and remove the rehearsal."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'SELECT title, author, youtube, version_of, creator_id, group_id FROM rehearsals WHERE id = ?',
            (reh_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        execute_write(cur, 
            'INSERT INTO suggestions (title, author, youtube, url, version_of, likes, creator_id, group_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
            (row['title'], row['author'], row['youtube'], row['youtube'], row['version_of'], row['creator_id'], row['group_id']),
        )
        new_id = cur.lastrowid
        execute_write(cur, 
            '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.version_of, s.likes, s.creator_id, s.created_at,
                      u.username AS creator FROM suggestions s JOIN users u ON u.id = s.creator_id
               WHERE s.id = ?''',
            (new_id,),
        )
        new_row = cur.fetchone()
        execute_write(cur, 'DELETE FROM rehearsals WHERE id = ? AND group_id = ?', (reh_id, row['group_id']))
        safe_commit(conn)
    if not new_row:
        return None
    return {
        'id': new_row['id'],
        'title': new_row['title'],
        'author': new_row['author'],
        'youtube': new_row['youtube'] or new_row['url'],
        'versionOf': new_row['version_of'],
        'creatorId': new_row['creator_id'],
        'creator': new_row['creator'],
        'createdAt': new_row['created_at'],
        'likes': new_row['likes'],
    }


def create_group(name: str, invitation_code: str, description: str | None, logo_url: str | None, owner_id: int) -> int:
    """Insert a new group and return its ID."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'INSERT INTO groups (name, invitation_code, description, logo_url, owner_id) VALUES (?, ?, ?, ?, ?)',
            (name, invitation_code, description, logo_url, owner_id),
        )
        group_id = cur.lastrowid
        # Insert default settings for the new group
        execute_write(cur, 
            "INSERT INTO settings (group_id, group_name, dark_mode, template) VALUES (?, ?, 1, 'classic')",
            (group_id, name),
        )
        safe_commit(conn)
    return group_id


def get_group_by_id(group_id: int) -> dict | None:
    """Fetch a group by its ID."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'SELECT id, name, invitation_code, description, logo_url, created_at, owner_id FROM groups WHERE id = ?',
            (group_id,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def get_group_by_code(code: str) -> dict | None:
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'SELECT id, name, invitation_code, description, logo_url, created_at, owner_id FROM groups WHERE invitation_code = ?',
            (code,),
        )
        row = cur.fetchone()
    return dict(row) if row else None


def get_groups_for_user(user_id: int) -> list[dict]:
    """Return all groups a user is a member of."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'SELECT g.id, g.name FROM groups g JOIN memberships m ON m.group_id = g.id WHERE m.user_id = ? AND m.active = 1',
            (user_id,),
        )
        rows = [{'id': row['id'], 'name': row['name']} for row in cur.fetchall()]
    return rows


def update_group(group_id: int, name: str, invitation_code: str, description: str | None, logo_url: str | None) -> int:
    """Update a group's details.  Returns number of affected rows."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'UPDATE groups SET name = ?, invitation_code = ?, description = ?, logo_url = ? WHERE id = ?',
            (name, invitation_code, description, logo_url, group_id),
        )
        safe_commit(conn)
        changes = cur.rowcount
    return changes


def update_group_code(group_id: int, invitation_code: str) -> int:
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 'UPDATE groups SET invitation_code = ? WHERE id = ?', (invitation_code, group_id))
        safe_commit(conn)
        changes = cur.rowcount
    return changes


def delete_group(group_id: int) -> int:
    """Delete a group by ID.  Returns the number of deleted rows."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 'DELETE FROM groups WHERE id = ?', (group_id,))
        safe_commit(conn)
        changes = cur.rowcount
    return changes


def create_membership(user_id: int, group_id: int, role: str, nickname: str | None, active: bool = True) -> int:
    """Create a membership entry linking a user to a group."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'INSERT INTO memberships (user_id, group_id, role, nickname, active) VALUES (?, ?, ?, ?, ?)',
            (user_id, group_id, role, nickname, 1 if active else 0),
        )
        membership_id = cur.lastrowid
        safe_commit(conn)
    return membership_id


def get_membership(user_id: int, group_id: int) -> dict | None:
    """Retrieve a membership for a user/group pair."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'SELECT id, user_id, group_id, role, nickname, joined_at, active FROM memberships WHERE user_id = ? AND group_id = ?',
            (user_id, group_id),
        )
        row = cur.fetchone()
    return dict(row) if row else None


ROLE_LEVELS = {'user': 1, 'moderator': 2, 'admin': 3}


def verify_group_access(user_id: int, group_id: int | None, required_role: str = 'user') -> str | None:
    """Return the membership role if the user has access to the group and
    meets the required role.  Otherwise return ``None``."""
    if group_id is None:
        return None
    membership = get_membership(user_id, group_id)
    if not membership or not membership.get('active'):
        return None
    if ROLE_LEVELS.get(membership['role'], 0) < ROLE_LEVELS.get(required_role, 0):
        return None
    return membership['role']


def get_group_members(group_id: int) -> list[dict]:
    """Return all members for a given group."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            '''SELECT m.id, m.user_id, m.group_id, m.role, m.nickname, m.joined_at, m.active, u.username
               FROM memberships m JOIN users u ON u.id = m.user_id
               WHERE m.group_id = ?
               ORDER BY m.joined_at ASC''',
            (group_id,),
        )
        rows = [dict(row) for row in cur.fetchall()]
    return rows


def update_membership(membership_id: int, role: str, nickname: str | None, active: bool) -> int:
    """Update membership details.  Returns number of affected rows."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 
            'UPDATE memberships SET role = ?, nickname = ?, active = ? WHERE id = ?',
            (role, nickname, 1 if active else 0, membership_id),
        )
        safe_commit(conn)
        changes = cur.rowcount
    return changes


def delete_membership(membership_id: int, group_id: int) -> int:
    """Delete a membership by its ID and group."""
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur,
            'DELETE FROM memberships WHERE id = ? AND group_id = ?',
            (membership_id, group_id),
        )
        safe_commit(conn)
        changes = cur.rowcount
    return changes


def send_push_to_group(group_id: int, title: str, body: str) -> None:
    """Send a Web Push notification to all subscribers in a group.

    Uses the ``web-push`` CLI via ``npx`` with VAPID keys supplied
    through environment variables ``VAPID_PUBLIC_KEY`` and
    ``VAPID_PRIVATE_KEY``.  Failures are silently ignored so that a
    notification issue does not affect the main request flow."""
    vapid_pub = os.environ.get('VAPID_PUBLIC_KEY')
    vapid_priv = os.environ.get('VAPID_PRIVATE_KEY')
    if not vapid_pub or not vapid_priv:
        return
    payload = json.dumps({'title': title, 'body': body})
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur,
            '''SELECT ps.endpoint, ps.p256dh, ps.auth
               FROM push_subscriptions ps
               JOIN memberships m ON m.user_id = ps.user_id
               WHERE m.group_id = ?''',
            (group_id,),
        )
        rows = cur.fetchall()
    for row in rows:
        try:
            subprocess.run([
                'npx', '-y', 'web-push', 'send-notification',
                f'--endpoint={row["endpoint"]}',
                f'--key={row["p256dh"]}',
                f'--auth={row["auth"]}',
                f'--payload={payload}',
                f'--vapid-subject=mailto:example@example.com',
                f'--vapid-pubkey={vapid_pub}',
                f'--vapid-pvtkey={vapid_priv}',
            ], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            continue

#############################
# HTTP request handler
#############################

class BandTrackHandler(BaseHTTPRequestHandler):
    """Request handler implementing both API and static file serving."""

    server_version = 'BandTrack/1.0'

    # Routing table: (HTTP method, regex pattern) -> handler method name
    ROUTES = [
        ('POST', r'^/api/register$', 'handle_auth'),
        ('POST', r'^/api/login$', 'handle_auth'),
        ('POST', r'^/api/logout$', 'handle_auth'),
        ('GET', r'^/api/me$', 'handle_auth'),
        ('DELETE', r'^/api/me$', 'handle_auth'),
        ('POST', r'^/api/webauthn/authenticate$', 'handle_auth'),
        ('POST', r'^/api/webauthn/register$', 'handle_auth'),
        ('PUT', r'^/api/password$', 'handle_auth'),
        ('GET', r'^/api/context$', 'handle_context'),
        ('PUT', r'^/api/context$', 'handle_context'),
        ('ANY', r'^/api/groups', 'handle_groups'),
        ('ANY', r'^/api/suggestions', 'handle_suggestions'),
        ('ANY', r'^/api/rehearsals', 'handle_rehearsals'),
        ('ANY', r'^/api/performances', 'handle_performances'),
        ('ANY', r'^/api/agenda', 'handle_agenda'),
        ('ANY', r'^/api/settings$', 'handle_settings'),
        ('ANY', r'^/api/user-settings$', 'handle_settings'),
        ('POST', r'^/api/push-subscribe$', 'handle_misc'),
        ('ANY', r'^/api/notifications$', 'handle_misc'),
        ('GET', r'^/api/repertoire\.pdf$', 'handle_misc'),
        ('ANY', r'^/api/logs$', 'handle_admin'),
        ('ANY', r'^/api/users', 'handle_admin'),
    ]

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
            # Serve static or uploaded files
            if path.startswith('/uploads/'):
                local_path = path.lstrip('/')
                upload_root = os.path.join(os.path.dirname(__file__), 'uploads')
                normalized = os.path.normpath(os.path.join(os.path.dirname(__file__), local_path))
                if not normalized.startswith(upload_root) or not os.path.isfile(normalized):
                    self.send_error(HTTPStatus.NOT_FOUND)
                    return
                # Require an authenticated session for uploaded files
                cookie_header = self.headers.get('Cookie', '')
                cookies = {}
                for part in cookie_header.split(';'):
                    if '=' in part:
                        name, value = part.strip().split('=', 1)
                        cookies[name] = value
                user = get_user_by_session(cookies.get('session_id'))
                if path.startswith('/uploads/partitions/'):
                    parts = local_path.split('/')
                    try:
                        reh_id = int(parts[2])
                    except (IndexError, ValueError):
                        self.send_error(HTTPStatus.NOT_FOUND)
                        return
                    group_id = None
                    with get_db_connection() as conn:
                        cur = conn.cursor()
                        execute_write(cur, 'SELECT group_id FROM rehearsals WHERE id = ?', (reh_id,))
                        row = cur.fetchone()
                        if row:
                            group_id = row['group_id']
                    if not user or verify_group_access(user['id'], group_id) is None:
                        self.send_error(HTTPStatus.FORBIDDEN)
                        return
                elif not user:
                    self.send_error(HTTPStatus.FORBIDDEN)
                    return
                send_text_file(self, normalized)
                return
            # Static public files.  Remove leading '/' and normalise path
            local_path = path.lstrip('/') or 'index.html'
            static_root = os.environ.get(
                'STATIC_ROOT',
                os.path.join(
                    os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
                    'public',
                ),
            )
            normalized = os.path.normpath(os.path.join(static_root, local_path))
            if not normalized.startswith(static_root):
                self.send_error(HTTPStatus.FORBIDDEN)
                return
            if os.path.isdir(normalized):
                normalized = os.path.join(normalized, 'index.html')
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

    def _find_route_handler(self, method: str, path: str):
        """Return the handler method for a given HTTP method and path."""
        for m, pattern, handler_name in self.ROUTES:
            if (m == method or m == 'ANY') and re.match(pattern, path):
                return getattr(self, handler_name)
        return None

    def handle_api_request(self, method: str, path: str, query: dict[str, list[str]]):
        """Dispatch API requests based on the path and HTTP method."""
        if method in ('POST', 'PUT', 'DELETE'):
            body_bytes = read_request_body(self)
            if body_bytes is None:
                return
            content_type = self.headers.get('Content-Type', '')
            if content_type.startswith('multipart/form-data'):
                body = body_bytes
            else:
                try:
                    body = json.loads(body_bytes.decode('utf-8')) if body_bytes else {}
                except json.JSONDecodeError:
                    send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid JSON'})
                    return
        else:
            body = {}

        cookie_header = self.headers.get('Cookie', '')
        cookies = {}
        for part in cookie_header.split(';'):
            if '=' in part:
                name, value = part.strip().split('=', 1)
                cookies[name] = value
        session_token = cookies.get('session_id')
        user = get_user_by_session(session_token)

        group_id_from_path = None
        parts = path.split('/')
        if len(parts) > 2 and parts[2].isdigit():
            group_id_from_path = int(parts[2])
            path = '/api/' + '/'.join(parts[3:])

        if user:
            user = dict(user)
            if group_id_from_path is not None:
                user['group_id'] = group_id_from_path

        try:
            handler = self._find_route_handler(method, path)
            if handler is None:
                self.send_error(HTTPStatus.NOT_FOUND)
                return
            if handler.__name__ != "handle_auth":
                if user is None or user.get('group_id') is None:
                    raise PermissionError
            return handler(method, path, query, body, user, session_token)
        except PermissionError:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        except NotImplementedError:
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED)
        except Exception as exc:
            print(f"Internal server error: {exc}")
            send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {'error': 'Internal server error'})

    def handle_auth(self, method, path, query, body, user, session_token):
        if path == '/api/register' and method == 'POST':
            return self.api_register(body)
        if path == '/api/login' and method == 'POST':
            return self.api_login(body)
        if path == '/api/logout' and method == 'POST':
            return self.api_logout(session_token)
        if path == '/api/me':
            if method == 'GET':
                return self.api_me(user)
            if method == 'DELETE':
                return self.api_delete_me(user, session_token)
        if path == '/api/webauthn/authenticate' and method == 'POST':
            return self.api_webauthn_authenticate(body)
        if path == '/api/webauthn/register' and method == 'POST':
            if user is None:
                raise PermissionError
            return self.api_webauthn_register(body, user)
        if path == '/api/password' and method == 'PUT':
            if user is None:
                raise PermissionError
            return self.api_update_password(body, user)
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_context(self, method, path, query, body, user, session_token):
        if path == '/api/context':
            if method == 'GET':
                return self.api_get_context(user)
            if method == 'PUT':
                return self.api_set_context(body, user, session_token)
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_groups(self, method, path, query, body, user, session_token):
        if path == '/api/groups':
            if method == 'POST':
                return self.api_create_group(body, user)
            if method == 'GET':
                return self.api_get_groups(user)
        if path == '/api/groups/join' and method == 'POST':
            return self.api_join_group(body, user)
        if path == '/api/groups/renew-code' and method == 'POST':
            return self.api_renew_group_code(user)
        if path.startswith('/api/groups/'):
            parts = path.split('/')
            if len(parts) == 4:
                try:
                    gid = int(parts[3])
                except ValueError:
                    return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid group id'})
                if method == 'PUT':
                    return self.api_update_group(gid, body, user)
            if len(parts) >= 5 and parts[4] == 'invite' and method == 'POST':
                try:
                    gid = int(parts[3])
                except ValueError:
                    return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid group id'})
                return self.api_group_invite(gid, body, user)
            if len(parts) >= 5 and parts[4] == 'members':
                try:
                    gid = int(parts[3])
                except ValueError:
                    return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid group id'})
                return self.api_group_members(gid, method, body, user)
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_suggestions(self, method, path, query, body, user, session_token):
        parts = path.split('/')
        if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
            if method == 'GET':
                return self.api_get_suggestions(user)
            if method == 'POST':
                return self.api_create_suggestion(body, user)
            raise NotImplementedError
        if len(parts) >= 4:
            try:
                sug_id = int(parts[3])
            except ValueError:
                return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
            if len(parts) == 5 and parts[4] == 'to-rehearsal' and method == 'POST':
                return self.api_move_suggestion_to_rehearsal_id(sug_id, user)
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
            raise NotImplementedError
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_rehearsals(self, method, path, query, body, user, session_token):
        parts = path.split('/')
        if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
            if method == 'GET':
                return self.api_get_rehearsals(user)
            if method == 'POST':
                return self.api_create_rehearsal(body, user)
            raise NotImplementedError
        if len(parts) == 5 and parts[4] == 'partitions':
            try:
                reh_id = int(parts[3])
            except ValueError:
                return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
            if method == 'GET':
                return self.api_get_rehearsal_partitions(reh_id, user)
            if method == 'POST':
                return self.api_post_rehearsal_partition(reh_id, body, self.headers, user)
            raise NotImplementedError
        if len(parts) == 6 and parts[4] == 'partitions':
            try:
                reh_id = int(parts[3])
                part_id = int(parts[5])
            except ValueError:
                return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
            if method == 'DELETE':
                return self.api_delete_rehearsal_partition(reh_id, part_id, user)
            raise NotImplementedError
        if len(parts) == 4:
            try:
                reh_id = int(parts[3])
            except ValueError:
                return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
            if method == 'GET':
                return self.api_get_rehearsal_id(reh_id, user)
            if method == 'PUT':
                return self.api_update_rehearsal_id(reh_id, body, user)
            if method == 'DELETE':
                return self.api_delete_rehearsal_id(reh_id, user)
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
            return self.api_move_rehearsal_to_suggestion_id(reh_id, user)
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_performances(self, method, path, query, body, user, session_token):
        parts = path.split('/')
        if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
            if method == 'GET':
                return self.api_get_performances(user)
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
            raise NotImplementedError
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_agenda(self, method, path, query, body, user, session_token):
        if path == '/api/agenda':
            if method == 'GET':
                return self.api_get_agenda(query, user)
            if method == 'POST':
                return self.api_create_agenda(body, user)
            raise NotImplementedError
        if path.startswith('/api/agenda/'):
            parts = path.split('/')
            if len(parts) == 4:
                try:
                    item_id = int(parts[3])
                except ValueError:
                    return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid ID'})
                if method == 'PUT':
                    return self.api_update_agenda_id(item_id, body, user)
                if method == 'DELETE':
                    return self.api_delete_agenda_id(item_id, body, user)
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_settings(self, method, path, query, body, user, session_token):
        if path == '/api/settings':
            if method == 'GET':
                return self.api_get_settings(user)
            if method == 'PUT':
                return self.api_update_settings(body, user)
            raise NotImplementedError
        if path == '/api/user-settings':
            if method == 'GET':
                return self.api_get_user_settings(user)
            if method == 'PUT':
                return self.api_update_user_settings(body, user)
            raise NotImplementedError
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_misc(self, method, path, query, body, user, session_token):
        if path == '/api/push-subscribe' and method == 'POST':
            return self.api_push_subscribe(body, user)
        if path == '/api/notifications':
            if method == 'GET':
                return self.api_get_notifications(user)
            raise NotImplementedError
        if path == '/api/repertoire.pdf' and method == 'GET':
            return self.api_repertoire_pdf(user)
        self.send_error(HTTPStatus.NOT_FOUND)

    def handle_admin(self, method, path, query, body, user, session_token):
        if path == '/api/logs':
            if not user or user.get('role') != 'admin':
                raise PermissionError
            if method == 'GET':
                return self.api_get_logs()
            raise NotImplementedError
        if path.startswith('/api/users'):
            if not user or user.get('role') != 'admin':
                raise PermissionError
            parts = path.split('/')
            if len(parts) == 3 or (len(parts) == 4 and parts[3] == ''):
                if method == 'GET':
                    return self.api_get_users()
                raise NotImplementedError
            if len(parts) == 4:
                try:
                    uid = int(parts[3])
                except ValueError:
                    return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid user id'})
                if method == 'PUT':
                    return self.api_update_user_id(uid, body, user)
                raise NotImplementedError
        self.send_error(HTTPStatus.NOT_FOUND)

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
        try:
            with get_db_connection() as conn:
                cur = conn.cursor()
                # Check if a user already exists (case‑insensitive)
                execute_write(cur, 'SELECT id FROM users WHERE LOWER(username) = LOWER(?)', (username,))
                if cur.fetchone():
                    send_json(self, HTTPStatus.CONFLICT, {'error': 'User already exists'})
                    return
                # Determine if this is the first user; if so, assign admin role
                execute_write(cur, 'SELECT COUNT(*) FROM users')
                count = cur.fetchone()[0]
                role = 'admin' if count == 0 else 'user'
                salt, pwd_hash = hash_password(password)
                execute_write(cur,
                    'INSERT INTO users (username, salt, password_hash, role, last_group_id) VALUES (?, ?, ?, ?, ?)',
                    (username, salt, pwd_hash, role, None),
                )
                user_id = cur.lastrowid
                # Ensure default group exists and is owned by the first user
                execute_write(cur, 'SELECT id FROM groups WHERE id = 1')
                if cur.fetchone() is None:
                    code = generate_unique_invitation_code()
                    execute_write(cur,
                        'INSERT INTO groups (id, name, invitation_code, owner_id) VALUES (1, ?, ?, ?)',
                        ('Groupe de musique', code, user_id),
                    )
                    execute_write(cur,
                        "INSERT INTO settings (group_id, group_name, dark_mode, template) VALUES (1, 'Groupe de musique', 1, 'classic')",
                    )
                # Add the new user to the default group (id 1)
                execute_write(cur,
                    'INSERT OR IGNORE INTO memberships (user_id, group_id, role, active) VALUES (?, 1, ?, 1)',
                    (user_id, role),
                )
                # Record last group for the user
                execute_write(cur, 'UPDATE users SET last_group_id = 1 WHERE id = ?', (user_id,))
                safe_commit(conn)
                group_id = 1
                # Automatically log in the new user and return a session cookie so the
                # behaviour mirrors the Express implementation.
                token = generate_session(user_id, group_id)
                expires_ts = int(time.time()) + 7 * 24 * 3600
                send_json(
                    self,
                    HTTPStatus.OK,
                    {'id': user_id, 'username': username, 'role': role, 'membershipRole': role},
                    cookies=[('session_id', token, {
                        'expires': expires_ts,
                        'path': '/',
                        'samesite': 'None',
                        'httponly': True,
                        'secure': cookie_secure(self),
                    })]
                )
        except (sqlite3.OperationalError, Psycopg2Error, RuntimeError) as e:
            logging.exception('Database connection failed during registration: %s', e)
            send_json(self, HTTPStatus.SERVICE_UNAVAILABLE, {'error': 'Database unavailable'})
        except sqlite3.IntegrityError as e:
            logging.exception('Database integrity error during registration: %s', e)
            send_json(self, HTTPStatus.CONFLICT, {'error': 'User already exists'})
        except sqlite3.Error as e:
            logging.exception('Database error during registration: %s', e)
            send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {'error': 'Registration failed'})
        except Exception as e:
            logging.exception('Unexpected error during registration: %s', e)
            send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {'error': 'Registration failed'})

    def api_login(self, body: dict):
        username = (body.get('username') or '').strip().lower()
        password = body.get('password') or ''
        if not username or not password:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Username and password are required'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            # Perform a case‑insensitive lookup for the username
            execute_write(cur, 
                'SELECT id, username, salt, password_hash, role, last_group_id FROM users WHERE LOWER(username) = LOWER(?)',
                (username,),
            )
            row = cur.fetchone()
            if not row:
                logger.warning("Login failed for user '%s': unknown user", username)
                send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Invalid credentials'})
                return
            salt = row['salt']
            pwd_hash = row['password_hash']
            if not verify_password(password, salt, pwd_hash):
                logger.warning("Login failed for user '%s': invalid password", username)
                send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Invalid credentials'})
                return
            # Determine the active group using the user's last choice if still valid
            group_id = row['last_group_id']
            if group_id is not None:
                execute_write(cur,
                    'SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ? AND active = 1',
                    (row['id'], group_id),
                )
                if not cur.fetchone():
                    group_id = None
            if group_id is None:
                execute_write(cur,
                    'SELECT group_id FROM memberships WHERE user_id = ? AND active = 1 ORDER BY group_id LIMIT 1',
                    (row['id'],),
                )
                g_row = cur.fetchone()
                group_id = g_row['group_id'] if g_row else None
            execute_write(cur, 'UPDATE users SET last_group_id = ? WHERE id = ?', (group_id, row['id']))
            safe_commit(conn)
            if group_id is None:
                token = generate_session(row['id'], None)
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
                            'membershipRole': None,
                            'needsGroup': True,
                            'isAdmin': row['role'] == 'admin',
                        },
                    },
                    cookies=[('session_id', token, {
                        'expires': expires_ts,
                        'path': '/',
                        'samesite': 'None',
                        'httponly': True,
                        'secure': cookie_secure(self),
                    })]
                )
                return
            token = generate_session(row['id'], group_id)
            expires_ts = int(time.time()) + 7 * 24 * 3600
            membership = get_membership(row['id'], group_id) if group_id else None
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
                        'membershipRole': membership['role'] if membership else None,
                        'isAdmin': row['role'] == 'admin',
                    },
                },
                cookies=[('session_id', token, {
                    'expires': expires_ts,
                    'path': '/',
                    'samesite': 'None',
                    'httponly': True,
                    'secure': cookie_secure(self),
                })]
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
            cookies=[('session_id', '', {
                'expires': past_ts,
                'path': '/',
                'samesite': 'None',
                'httponly': True,
                'secure': cookie_secure(self),
            })]
        )

    def api_me(self, user: dict | None):
        if not user:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
            return
        if user.get('group_id') is None:
            send_json(self, HTTPStatus.OK, {
                'id': user['id'],
                'username': user['username'],
                'role': user.get('role'),
                'needsGroup': True,
                'isAdmin': user.get('role') == 'admin',
            })
            return
        membership_role = verify_group_access(user['id'], user['group_id'])
        if not membership_role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'No membership'})
            return
        send_json(self, HTTPStatus.OK, {
            'id': user['id'],
            'username': user['username'],
            'role': user.get('role'),
            'membershipRole': membership_role,
            'isAdmin': user.get('role') == 'admin',
        })

    def api_delete_me(self, user: dict | None, session_token: str):
        """Delete the current user's account and associated data."""
        if not user:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            uid = user['id']
            execute_write(cur, 'SELECT COUNT(*) FROM groups WHERE owner_id = ?', (uid,))
            if cur.fetchone()[0] > 0:
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Cannot delete account while owning a group'})
                return
            execute_write(cur, 'DELETE FROM suggestion_votes WHERE user_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM suggestions WHERE creator_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM rehearsals WHERE creator_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM performances WHERE creator_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM rehearsal_events WHERE creator_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM memberships WHERE user_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM sessions WHERE user_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM users_webauthn WHERE user_id = ?', (uid,))
            execute_write(cur, 'UPDATE logs SET user_id = NULL WHERE user_id = ?', (uid,))
            execute_write(cur, 'DELETE FROM users WHERE id = ?', (uid,))
            safe_commit(conn)
            if session_token:
                delete_session(session_token)
            log_event(None, 'delete_account', {'user_id': uid})
            past_ts = int(time.time()) - 3600
            send_json(
                self,
                HTTPStatus.OK,
                {'message': 'Account deleted'},
                cookies=[('session_id', '', {
                    'expires': past_ts,
                    'path': '/',
                    'samesite': 'None',
                    'httponly': True,
                    'secure': cookie_secure(self),
                })]
            )

    def api_webauthn_register(self, body: dict, user: dict):
        """Store a new WebAuthn credential for the logged-in user."""
        credential_id = (body.get('credentialId') or '').strip()
        if not credential_id:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'credentialId is required'})
            return
        try:
            add_webauthn_credential(user['id'], credential_id)
        except (sqlite3.IntegrityError, psycopg2.IntegrityError if psycopg2 else sqlite3.IntegrityError):
            send_json(self, HTTPStatus.CONFLICT, {'error': 'Credential already registered'})
            return
        send_json(self, HTTPStatus.OK, {'message': 'Credential registered'})

    def api_webauthn_authenticate(self, body: dict):
        """Authenticate using a WebAuthn credential and create a session."""
        credential_id = (body.get('credentialId') or '').strip()
        if not credential_id:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'credentialId is required'})
            return
        user_row = get_user_by_webauthn_credential(credential_id)
        if not user_row:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Invalid credential'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            group_id = user_row.get('last_group_id')
            if group_id is not None:
                execute_write(cur, 
                    'SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ? AND active = 1',
                    (user_row['id'], group_id),
                )
                if not cur.fetchone():
                    group_id = None
            if group_id is None:
                execute_write(cur, 
                    'SELECT group_id FROM memberships WHERE user_id = ? AND active = 1 ORDER BY group_id LIMIT 1',
                    (user_row['id'],),
                )
                g_row = cur.fetchone()
                group_id = g_row['group_id'] if g_row else None
            execute_write(cur, 'UPDATE users SET last_group_id = ? WHERE id = ?', (group_id, user_row['id']))
            safe_commit(conn)
            token = generate_session(user_row['id'], group_id)
            expires_ts = int(time.time()) + 7 * 24 * 3600
            membership = get_membership(user_row['id'], group_id) if group_id else None
            log_event(user_row['id'], 'login', {'username': user_row['username'], 'method': 'webauthn'})
            payload = {
                'id': user_row['id'],
                'username': user_row['username'],
                'role': user_row['role'],
                'membershipRole': membership['role'] if membership else None,
                'needsGroup': group_id is None,
                'isAdmin': user_row['role'] == 'admin',
            }
            send_json(
                self,
                HTTPStatus.OK,
                {'message': 'Logged in', 'user': payload},
                cookies=[('session_id', token, {
                    'expires': expires_ts,
                    'path': '/',
                    'samesite': 'None',
                    'httponly': True,
                    'secure': cookie_secure(self),
                })],
            )

    def api_update_password(self, body: dict, user: dict):
        old_password = body.get('oldPassword') or ''
        new_password = body.get('newPassword') or ''
        if not old_password or not new_password:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'oldPassword and newPassword are required'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT salt, password_hash FROM users WHERE id = ?', (user['id'],))
            row = cur.fetchone()
            if not row:
                send_json(self, HTTPStatus.INTERNAL_SERVER_ERROR, {'error': 'User not found'})
                return
            if not verify_password(old_password, row['salt'], row['password_hash']):
                send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Invalid current password'})
                return
            new_salt, new_hash = hash_password(new_password)
            execute_write(cur, 'UPDATE users SET salt = ?, password_hash = ? WHERE id = ?', (new_salt, new_hash, user['id']))
            safe_commit(conn)
            log_event(user['id'], 'password_change', {})
            send_json(self, HTTPStatus.OK, {'message': 'Password updated'})

    def api_get_context(self, user: dict):
        """Return the currently active group for the session."""
        if user.get('group_id') is None:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'No active group'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT id, name FROM groups WHERE id = ?', (user['group_id'],))
            row = cur.fetchone()
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
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                'SELECT 1 FROM memberships WHERE user_id = ? AND group_id = ? AND active = 1',
                (user['id'], group_id)
            )
            if not cur.fetchone():
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'No membership'})
                return
            execute_write(cur, 'UPDATE sessions SET group_id = ? WHERE token = ?', (group_id, session_token))
            execute_write(cur, 'UPDATE users SET last_group_id = ? WHERE id = ?', (group_id, user['id']))
            execute_write(cur, 'SELECT id, name FROM groups WHERE id = ?', (group_id,))
            row = cur.fetchone()
            safe_commit(conn)
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

    def api_update_group(self, group_id: int, body: dict, user: dict):
        """Rename a group. Admin role required."""
        role = verify_group_access(user['id'], group_id, 'admin')
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        name = (body.get('name') or '').strip()
        if not name:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'name is required'})
            return
        group = get_group_by_id(group_id)
        if not group:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Group not found'})
            return
        update_group(
            group_id,
            name,
            group['invitation_code'],
            group.get('description'),
            group.get('logo_url'),
        )
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'UPDATE settings SET group_name = ? WHERE group_id = ?', (name, group_id))
            safe_commit(conn)
            send_json(self, HTTPStatus.OK, {'id': group_id, 'name': name})

    def api_get_groups(self, user: dict):
        groups = get_groups_for_user(user['id'])
        send_json(self, HTTPStatus.OK, groups)

    def api_group_members(self, group_id: int, method: str, body: dict, user: dict):
        role = verify_group_access(user['id'], group_id)
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        if method == 'GET':
            members = get_group_members(group_id)
            result = []
            for m in members:
                result.append({
                    'id': m['id'],
                    'userId': m['user_id'],
                    'username': m['username'],
                    'role': m['role'],
                    'nickname': m['nickname'],
                    'joinedAt': m['joined_at'],
                    'active': bool(m['active']),
                })
            send_json(self, HTTPStatus.OK, result)
            return
        if method == 'POST':
            if role != 'admin':
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
                return
            try:
                target_user_id = int(body.get('userId'))
            except (TypeError, ValueError):
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid user id'})
                return
            new_role = body.get('role', 'user')
            if new_role not in ('user', 'moderator', 'admin'):
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid role'})
                return
            nickname = body.get('nickname')
            with get_db_connection() as conn:
                cur = conn.cursor()
                execute_write(cur, 'SELECT id, username FROM users WHERE id = ?', (target_user_id,))
                row = cur.fetchone()
                if not row:
                    send_json(self, HTTPStatus.NOT_FOUND, {'error': 'User not found'})
                    return
                if get_membership(target_user_id, group_id):
                    send_json(self, HTTPStatus.CONFLICT, {'error': 'Membership already exists'})
                    return
                create_membership(target_user_id, group_id, new_role, nickname)
                membership = get_membership(target_user_id, group_id)
                send_json(self, HTTPStatus.CREATED, {
                    'id': membership['id'],
                    'userId': membership['user_id'],
                    'username': row['username'],
                    'role': membership['role'],
                    'nickname': membership['nickname'],
                    'joinedAt': membership['joined_at'],
                    'active': bool(membership['active']),
                })
                return
        if method == 'PUT':
            if role != 'admin':
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
                return
            try:
                membership_id = int(body.get('id'))
            except (TypeError, ValueError):
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid membership id'})
                return
            new_role = body.get('role')
            nickname = body.get('nickname')
            active = bool(body.get('active', True))
            if new_role not in ('user', 'moderator', 'admin'):
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid role'})
                return
            updated = update_membership(membership_id, new_role, nickname, active)
            if updated:
                send_json(self, HTTPStatus.OK, {'message': 'Member updated'})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Membership not found'})
            return
        if method == 'DELETE':
            membership_id = None
            target_user_id = None
            if body.get('id') is None and body.get('userId') is None:
                log_event(user['id'], 'delete_member_failed', {'groupId': group_id, 'reason': 'missing member identifier'})
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Missing member identifier'})
                return
            if body.get('id') is None:
                try:
                    target_user_id = int(body.get('userId'))
                except (TypeError, ValueError):
                    send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid user id'})
                    return
                membership = get_membership(target_user_id, group_id)
                if not membership:
                    send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Membership not found'})
                    return
                membership_id = membership['id']
            else:
                try:
                    membership_id = int(body.get('id'))
                except (TypeError, ValueError):
                    send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid membership id'})
                    return
                with get_db_connection() as conn:
                    cur = conn.cursor()
                    execute_write(cur, 'SELECT user_id FROM memberships WHERE id = ? AND group_id = ?', (membership_id, group_id))
                    row = cur.fetchone()
                    if not row:
                        send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Membership not found'})
                        return
                    target_user_id = row['user_id']
            if role != 'admin' and target_user_id != user['id']:
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
                return
            deleted = delete_membership(membership_id, group_id)
            if not deleted:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Membership not found'})
                return
            if target_user_id == user['id']:
                remaining = get_groups_for_user(user['id'])
                new_group_id = remaining[0]['id'] if remaining else None
                with get_db_connection() as conn:
                    cur = conn.cursor()
                    execute_write(cur, 'UPDATE users SET last_group_id = ? WHERE id = ?', (new_group_id, user['id']))
                    execute_write(cur, 'UPDATE sessions SET group_id = ? WHERE user_id = ?', (new_group_id, user['id']))
                    safe_commit(conn)
                    send_json(self, HTTPStatus.OK, {'message': 'Left group'})
            else:
                send_json(self, HTTPStatus.OK, {'message': 'Member deleted'})
            return
        raise NotImplementedError

    def api_group_invite(self, group_id: int, body: dict, user: dict):
        """Invite a user to the group by email. If the email does not
        correspond to an existing user, create a provisional account with a
        temporary password."""
        role = verify_group_access(user['id'], group_id, 'admin')
        if role != 'admin':
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        email = (body.get('email') or '').strip().lower()
        if not email or '@' not in email:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid email'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT id, username FROM users WHERE LOWER(username) = LOWER(?)', (email,))
            row = cur.fetchone()
            if row:
                user_id = row['id']
                username = row['username']
                if get_membership(user_id, group_id):
                    send_json(self, HTTPStatus.CONFLICT, {'error': 'Membership already exists'})
                    return
                create_membership(user_id, group_id, 'user', None)
                membership = get_membership(user_id, group_id)
                send_json(self, HTTPStatus.CREATED, {
                    'id': membership['id'],
                    'userId': membership['user_id'],
                    'username': username,
                    'role': membership['role'],
                    'nickname': membership['nickname'],
                    'joinedAt': membership['joined_at'],
                    'active': bool(membership['active']),
                })
                return
            # Create provisional user
            temp_password = ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(12))
            salt, pwd_hash = hash_password(temp_password)
            execute_write(cur, 
                'INSERT INTO users (username, salt, password_hash, role, last_group_id) VALUES (?, ?, ?, ?, ?)',
                (email, salt, pwd_hash, 'user', group_id),
            )
            user_id = cur.lastrowid
            execute_write(cur, 
                'INSERT INTO memberships (user_id, group_id, role, nickname, active) VALUES (?, ?, ?, ?, 1)',
                (user_id, group_id, 'user', None),
            )
            safe_commit(conn)
            membership = get_membership(user_id, group_id)
            send_json(self, HTTPStatus.CREATED, {
                'id': membership['id'],
                'userId': membership['user_id'],
                'username': email,
                'role': membership['role'],
                'nickname': membership['nickname'],
                'joinedAt': membership['joined_at'],
                'active': bool(membership['active']),
                'temporaryPassword': temp_password,
            })

    def api_get_suggestions(self, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.version_of, s.likes, s.creator_id, s.created_at, u.username AS creator
                   FROM suggestions s
                   JOIN users u ON u.id = s.creator_id
                   WHERE s.group_id = ?
                   ORDER BY s.likes DESC, s.created_at ASC''',
                (user['group_id'],)
            )
            rows = [dict(row) for row in cur.fetchall()]
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
                    'versionOf': r['version_of'],
                }
                result.append(entry)
            send_json(self, HTTPStatus.OK, result)

    def api_create_suggestion(self, body: dict, user: dict):
        title = (body.get('title') or '').strip()
        author = (body.get('author') or '').strip() or None
        youtube = (body.get('youtube') or body.get('url') or '').strip() or None
        version_of = (body.get('versionOf') or '').strip() or None
        if not title:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Title is required'})
            return
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                'INSERT INTO suggestions (title, author, youtube, url, version_of, group_id, creator_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
                (title, author, youtube, youtube, version_of, user['group_id'], user['id'])
            )
            suggestion_id = cur.lastrowid
            # Retrieve the created row with creator username and timestamp
            execute_write(cur, 
                '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.version_of, s.likes,
                         s.creator_id, s.created_at, u.username AS creator
                   FROM suggestions s JOIN users u ON u.id = s.creator_id
                   WHERE s.id = ? AND s.group_id = ?''',
                (suggestion_id, user['group_id'])
            )
            row = cur.fetchone()
            safe_commit(conn)
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
                    'versionOf': row['version_of'],
                }
                send_json(self, HTTPStatus.CREATED, result)
                send_push_to_group(user['group_id'], 'Nouvelle suggestion', f"{row['title']}")
                broadcast_ws({'type': 'suggestion:new', 'suggestion': result, 'groupId': user['group_id']})
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
        with get_db_connection() as conn:
            cur = conn.cursor()
            if user.get('role') in ('admin', 'moderator'):
                execute_write(cur, 'DELETE FROM suggestions WHERE id = ? AND group_id = ?', (sug_id, user['group_id']))
            else:
                execute_write(cur, 
                    'DELETE FROM suggestions WHERE id = ? AND creator_id = ? AND group_id = ?',
                    (sug_id, user['id'], user['group_id'])
                )
            deleted = cur.rowcount
            if deleted:
                execute_write(cur, 'DELETE FROM suggestion_votes WHERE suggestion_id = ?', (sug_id,))
            safe_commit(conn)
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

    def api_get_rehearsals(self, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                '''SELECT r.id, r.title, r.author, r.youtube, r.spotify, r.version_of, r.audio_notes_json, r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at, u.username AS creator
                   FROM rehearsals r JOIN users u ON u.id = r.creator_id
                   WHERE r.group_id = ?''',
                (user['group_id'],)
            )
            rows = []
            for row in cur.fetchall():
                levels = json.loads(row['levels_json'] or '{}')
                notes = json.loads(row['notes_json'] or '{}')
                audio_notes = parse_audio_notes_json(row['audio_notes_json'])
                avg = (
                    sum(float(v) for v in levels.values()) / len(levels)
                    if levels
                    else 0.0
                )
                rows.append({
                    'id': row['id'],
                    'title': row['title'],
                    'author': row['author'],
                    'youtube': row['youtube'],
                    'spotify': row['spotify'],
                    'versionOf': row['version_of'],
                    'audioNotes': audio_notes,
                    'levels': levels,
                    'notes': notes,
                    'mastered': bool(row['mastered']),
                    'creatorId': row['creator_id'],
                    'creator': row['creator'],
                    'createdAt': row['created_at'],
                    'avgLevel': avg,
                })
            rows.sort(key=lambda r: r['avgLevel'], reverse=True)
            send_json(self, HTTPStatus.OK, rows)

    def api_get_rehearsal_id(self, rehearsal_id: int, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                '''SELECT r.id, r.title, r.author, r.youtube, r.spotify, r.version_of, r.audio_notes_json,
                          r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at, u.username AS creator
                   FROM rehearsals r JOIN users u ON u.id = r.creator_id
                   WHERE r.id = ? AND r.group_id = ?''',
                (rehearsal_id, user['group_id']),
            )
            row = cur.fetchone()
            if not row:
                return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
            levels = json.loads(row['levels_json'] or '{}')
            notes = json.loads(row['notes_json'] or '{}')
            audio_notes = parse_audio_notes_json(row['audio_notes_json'])
            avg = (
                sum(float(v) for v in levels.values()) / len(levels)
                if levels
                else 0.0
            )
            send_json(
                self,
                HTTPStatus.OK,
                {
                    'id': row['id'],
                    'title': row['title'],
                    'author': row['author'],
                    'youtube': row['youtube'],
                    'spotify': row['spotify'],
                    'versionOf': row['version_of'],
                    'audioNotes': audio_notes,
                    'levels': levels,
                    'notes': notes,
                    'mastered': bool(row['mastered']),
                    'creatorId': row['creator_id'],
                    'creator': row['creator'],
                    'createdAt': row['created_at'],
                    'avgLevel': avg,
                },
            )

    def api_create_rehearsal(self, body: dict, user: dict):
        title = (body.get('title') or '').strip()
        author = (body.get('author') or '').strip() or None
        youtube = (body.get('youtube') or '').strip() or None
        spotify = (body.get('spotify') or '').strip() or None
        version_of = (body.get('versionOf') or '').strip() or None
        if not title:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Title is required'})
            return
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur,
                'INSERT INTO rehearsals (title, author, youtube, spotify, version_of, levels_json, notes_json, audio_notes_json, mastered, creator_id, group_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                (title, author, youtube, spotify, version_of, json.dumps({}), json.dumps({}), json.dumps({}), 0, user['id'], user['group_id'])
            )
            rehearsal_id = cur.lastrowid
            safe_commit(conn)
            rehearsal = {'id': rehearsal_id, 'title': title, 'author': author, 'youtube': youtube, 'spotify': spotify, 'mastered': False, 'versionOf': version_of, 'sheetMusic': {}}
            send_json(self, HTTPStatus.CREATED, rehearsal)
            send_push_to_group(user['group_id'], 'Nouvelle répétition', title)
            broadcast_ws({'type': 'rehearsal:new', 'rehearsal': rehearsal, 'groupId': user['group_id']})

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

    def api_get_performances(self, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                '''SELECT p.id, p.name, p.date, p.location, p.songs_json, p.creator_id, u.username AS creator
                   FROM performances p JOIN users u ON u.id = p.creator_id
                   WHERE p.group_id = ?
                   ORDER BY p.date ASC''',
                (user['group_id'],)
            )
            result = []
            for row in cur.fetchall():
                result.append({
                    'id': row['id'],
                    'name': row['name'],
                    'date': row['date'],
                    'location': row['location'],
                    'songs': json.loads(row['songs_json'] or '[]'),
                    'creatorId': row['creator_id'],
                    'creator': row['creator'],
                })
            # Return the list directly to align with the Express API
            send_json(self, HTTPStatus.OK, result)

    def api_create_performance(self, body: dict, user: dict):
        name = (body.get('name') or '').strip()
        date = (body.get('date') or '').strip()
        location = (body.get('location') or '').strip()
        songs = body.get('songs') or []
        if not name or not date:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
            return
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        # Validate songs: ensure list of ints
        try:
            songs_list = [int(s) for s in songs]
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                'INSERT INTO performances (name, date, location, songs_json, creator_id, group_id) VALUES (?, ?, ?, ?, ?, ?)',
                 (name, date, location, json.dumps(songs_list), user['id'], user['group_id'])
            )
            perf_id = cur.lastrowid
            safe_commit(conn)
            send_json(self, HTTPStatus.CREATED, {'id': perf_id, 'name': name, 'date': date, 'location': location, 'songs': songs_list})

    def api_update_performance(self, body: dict, user: dict):
        try:
            perf_id = int(body.get('id'))
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid performance id'})
            return
        name = (body.get('name') or '').strip()
        date = (body.get('date') or '').strip()
        location = (body.get('location') or '').strip()
        songs = body.get('songs') or []
        if not name or not date:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
            return
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        try:
            songs_list = [int(s) for s in songs]
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            # Allow update if current user is creator or has moderator/administrator role
            if role in ('admin', 'moderator'):
                execute_write(cur, 
                    'UPDATE performances SET name = ?, date = ?, location = ?, songs_json = ? WHERE id = ? AND group_id = ?',
                    (name, date, location, json.dumps(songs_list), perf_id, user['group_id'])
                )
            else:
                execute_write(cur, 
                    'UPDATE performances SET name = ?, date = ?, location = ?, songs_json = ? WHERE id = ? AND creator_id = ? AND group_id = ?',
                    (name, date, location, json.dumps(songs_list), perf_id, user['id'], user['group_id'])
                )
            updated = cur.rowcount
            safe_commit(conn)
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
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            if role in ('admin', 'moderator'):
                execute_write(cur, 'DELETE FROM suggestions WHERE id = ? AND group_id = ?', (sug_id, user['group_id']))
            else:
                execute_write(cur, 
                    'DELETE FROM suggestions WHERE id = ? AND creator_id = ? AND group_id = ?',
                    (sug_id, user['id'], user['group_id'])
                )
            deleted = cur.rowcount
            if deleted:
                execute_write(cur, 'DELETE FROM suggestion_votes WHERE suggestion_id = ?', (sug_id,))
            safe_commit(conn)
            if deleted:
                send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found or not owned'})

    def api_vote_suggestion_id(self, sug_id: int, user: dict):
        """Register a user's vote for a suggestion and return the updated row."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT 1 FROM suggestions WHERE id = ? AND group_id = ?', (sug_id, user['group_id']))
            if not cur.fetchone():
                return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})
            execute_write(cur, 
                'INSERT OR IGNORE INTO suggestion_votes (suggestion_id, user_id) VALUES (?, ?)',
                (sug_id, user['id'])
            )
            execute_write(cur, 'SELECT COUNT(*) FROM suggestion_votes WHERE suggestion_id = ?', (sug_id,))
            likes = cur.fetchone()[0]
            execute_write(cur, 'UPDATE suggestions SET likes = ? WHERE id = ?', (likes, sug_id))
            execute_write(cur, 
                '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.version_of, s.likes, s.creator_id, s.created_at,
                          u.username AS creator FROM suggestions s JOIN users u ON u.id = s.creator_id
                   WHERE s.id = ? AND s.group_id = ?''',
                (sug_id, user['group_id'])
            )
            row = cur.fetchone()
            safe_commit(conn)
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
                    'versionOf': row['version_of'],
                }
                log_event(user['id'], 'vote', {'suggestionId': sug_id})
                send_json(self, HTTPStatus.OK, result)
                broadcast_ws({'type': 'suggestion:vote', 'suggestion': result, 'groupId': user['group_id']})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})

    def api_unvote_suggestion_id(self, sug_id: int, user: dict):
        """Remove a user's vote for a suggestion and return the updated row."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT 1 FROM suggestions WHERE id = ? AND group_id = ?', (sug_id, user['group_id']))
            if not cur.fetchone():
                return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})
            execute_write(cur, 
                'DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?',
                (sug_id, user['id'])
            )
            execute_write(cur, 'SELECT COUNT(*) FROM suggestion_votes WHERE suggestion_id = ?', (sug_id,))
            likes = cur.fetchone()[0]
            execute_write(cur, 'UPDATE suggestions SET likes = ? WHERE id = ?', (likes, sug_id))
            execute_write(cur, 
                '''SELECT s.id, s.title, s.author, s.youtube, s.url, s.version_of, s.likes, s.creator_id, s.created_at,
                          u.username AS creator FROM suggestions s JOIN users u ON u.id = s.creator_id
                   WHERE s.id = ? AND s.group_id = ?''',
                (sug_id, user['group_id'])
            )
            row = cur.fetchone()
            safe_commit(conn)
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
                    'versionOf': row['version_of'],
                }
                log_event(user['id'], 'unvote', {'suggestionId': sug_id})
                send_json(self, HTTPStatus.OK, result)
                broadcast_ws({'type': 'suggestion:vote', 'suggestion': result, 'groupId': user['group_id']})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})

    def api_update_suggestion_id(self, sug_id: int, body: dict, user: dict):
        """Update a suggestion's title and optional fields by ID."""
        title = (body.get('title') or '').strip()
        author = (body.get('author') or '').strip() or None
        youtube = (body.get('youtube') or body.get('url') or '').strip() or None
        version_of = (body.get('versionOf') or '').strip() or None
        if not title:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Title is required'})
            return
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            if role in ('admin', 'moderator'):
                execute_write(cur, 
                    'UPDATE suggestions SET title = ?, author = ?, youtube = ?, url = ?, version_of = ? WHERE id = ? AND group_id = ?',
                    (title, author, youtube, youtube, version_of, sug_id, user['group_id']),
                )
            else:
                execute_write(cur, 
                    'UPDATE suggestions SET title = ?, author = ?, youtube = ?, url = ?, version_of = ? WHERE id = ? AND creator_id = ? AND group_id = ?',
                    (title, author, youtube, youtube, version_of, sug_id, user['id'], user['group_id']),
                )
            updated = cur.rowcount
            if updated:
                safe_commit(conn)
                log_event(user['id'], 'edit', {'entity': 'suggestion', 'id': sug_id})
                send_json(self, HTTPStatus.OK, {'message': 'Updated'})
            else:
                # Determine if the suggestion exists
                execute_write(cur, 'SELECT 1 FROM suggestions WHERE id = ? AND group_id = ?', (sug_id, user['group_id']))
                exists = cur.fetchone()
                safe_commit(conn)
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
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        # Determine which fields are being updated
        title = body.get('title')
        author = body.get('author')
        youtube = body.get('youtube')
        spotify = body.get('spotify')
        version_of = body.get('versionOf')
        level = body.get('level')
        note = body.get('note')
        audio_b64 = body.get('audio')
        audio_title = body.get('audioTitle')
        audio_index = body.get('audioIndex')
        # If nothing to update, return error
        if all(
            v is None
            for v in (
                title,
                author,
                youtube,
                spotify,
                version_of,
                level,
                note,
                audio_b64,
                audio_index,
            )
        ):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Nothing to update'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            # Fetch current rehearsal record including author and audio notes JSON
            execute_write(cur, 
                'SELECT title, author, youtube, spotify, version_of, levels_json, notes_json, audio_notes_json, mastered, creator_id '
                'FROM rehearsals WHERE id = ? AND group_id = ?',
                (rehearsal_id, user['group_id'])
            )
            row = cur.fetchone()
            if not row:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
                return
            # Prepare modifications
            updated_metadata = False
            # Check if we need to update metadata
            if any(v is not None for v in (title, author, youtube, spotify, version_of)):
                # Only creator, moderator or admin can modify metadata
                if not (role in ('admin', 'moderator') or user['id'] == row['creator_id']):
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
                new_version = (version_of or '').strip() if version_of is not None else row['version_of']
                new_version = new_version or None
                # Update the row
                execute_write(cur, 
                    'UPDATE rehearsals SET title = ?, author = ?, youtube = ?, spotify = ?, version_of = ? WHERE id = ? AND group_id = ?',
                    (new_title, new_author, new_youtube, new_spotify, new_version, rehearsal_id, user['group_id'])
                )
                updated_metadata = cur.rowcount > 0
            # Update level/note/audio if provided
            updated_levels_notes_audio = False
            if (
                level is not None
                or note is not None
                or audio_b64 is not None
                or audio_index is not None
            ):
                # Parse JSON fields
                levels = json.loads(row['levels_json'] or '{}')
                notes = json.loads(row['notes_json'] or '{}')
                audio_notes = parse_audio_notes_json(row['audio_notes_json'])
                if level is not None:
                    try:
                        level_val = float(level)
                    except (TypeError, ValueError):
                        send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid level'})
                        return
                    levels[user['username']] = max(0, min(10, level_val))
                if note is not None:
                    notes[user['username']] = str(note)
                if audio_b64 is not None:
                    # Accept empty string to clear all notes for user
                    if audio_b64 == '':
                        audio_notes.pop(user['username'], None)
                    else:
                        note_obj = {'title': (audio_title or '').strip(), 'audio': str(audio_b64)}
                        audio_notes.setdefault(user['username'], []).append(note_obj)
                elif audio_index is not None:
                    user_list = audio_notes.get(user['username'], [])
                    try:
                        idx = int(audio_index)
                        if 0 <= idx < len(user_list):
                            del user_list[idx]
                        if user_list:
                            audio_notes[user['username']] = user_list
                        else:
                            audio_notes.pop(user['username'], None)
                    except (TypeError, ValueError):
                        pass
                execute_write(cur, 
                    'UPDATE rehearsals SET levels_json = ?, notes_json = ?, audio_notes_json = ? WHERE id = ? AND group_id = ?',
                    (
                        json.dumps(levels),
                        json.dumps(notes),
                        json.dumps(audio_notes),
                        rehearsal_id,
                        user['group_id'],
                    ),
                )
                updated_levels_notes_audio = cur.rowcount > 0
            safe_commit(conn)
            if updated_metadata or updated_levels_notes_audio:
                log_event(user['id'], 'edit', {'entity': 'rehearsal', 'id': rehearsal_id})
                execute_write(cur, 'SELECT id, title, author, youtube, spotify, version_of, levels_json, notes_json, audio_notes_json, mastered FROM rehearsals WHERE id = ? AND group_id = ?', (rehearsal_id, user['group_id']))
                updated_row = cur.fetchone()
                if updated_row:
                    rehearsal = {
                        'id': updated_row['id'],
                        'title': updated_row['title'],
                        'author': updated_row['author'],
                        'youtube': updated_row['youtube'],
                        'spotify': updated_row['spotify'],
                        'versionOf': updated_row['version_of'],
                        'levels': json.loads(updated_row['levels_json'] or '{}'),
                        'notes': json.loads(updated_row['notes_json'] or '{}'),
                        'audioNotes': parse_audio_notes_json(updated_row['audio_notes_json']),
                        'mastered': bool(updated_row['mastered']),
                    }
                    broadcast_ws({'type': 'rehearsal:update', 'rehearsal': rehearsal, 'groupId': user['group_id']})
                send_json(self, HTTPStatus.OK, {'message': 'Updated'})
            else:
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Nothing was updated'})

    def api_toggle_rehearsal_mastered(self, rehearsal_id: int, user: dict):
        """Toggle the mastered flag for a rehearsal."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT mastered, creator_id FROM rehearsals WHERE id = ? AND group_id = ?', (rehearsal_id, user['group_id']))
            row = cur.fetchone()
            if not row:
                return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
            if not (role in ('admin', 'moderator') or user['id'] == row['creator_id']):
                return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not allowed to edit rehearsal'})
            new_val = 0 if row['mastered'] else 1
            execute_write(cur, 'UPDATE rehearsals SET mastered = ? WHERE id = ? AND group_id = ?', (new_val, rehearsal_id, user['group_id']))
            safe_commit(conn)
            execute_write(cur, 
                '''SELECT r.id, r.title, r.author, r.youtube, r.spotify, r.version_of, r.audio_notes_json,
                          r.levels_json, r.notes_json, r.mastered, r.creator_id, r.created_at,
                          u.username AS creator FROM rehearsals r JOIN users u ON u.id = r.creator_id
                   WHERE r.id = ? AND r.group_id = ?''',
                (rehearsal_id, user['group_id'])
            )
            updated = cur.fetchone()
            if updated:
                levels = json.loads(updated['levels_json'] or '{}')
                notes = json.loads(updated['notes_json'] or '{}')
                audio_notes = parse_audio_notes_json(updated['audio_notes_json'])
                rehearsal = {
                    'id': updated['id'],
                    'title': updated['title'],
                    'author': updated['author'],
                    'youtube': updated['youtube'],
                    'spotify': updated['spotify'],
                    'versionOf': updated['version_of'],
                    'audioNotes': audio_notes,
                    'levels': levels,
                    'notes': notes,
                    'mastered': bool(updated['mastered']),
                    'creatorId': updated['creator_id'],
                    'creator': updated['creator'],
                    'createdAt': updated['created_at'],
                }
                send_json(self, HTTPStatus.OK, rehearsal)
                broadcast_ws({'type': 'rehearsal:update', 'rehearsal': rehearsal, 'groupId': user['group_id']})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})

    def api_get_rehearsal_partitions(self, rehearsal_id: int, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                '''SELECT p.id, p.display_name, p.uploaded_at, p.path, u.username
                   FROM partitions p
                   JOIN rehearsals r ON r.id = p.rehearsal_id
                   JOIN users u ON u.id = p.uploader_id
                   WHERE p.rehearsal_id = ? AND r.group_id = ?''',
                (rehearsal_id, user['group_id']),
            )
            rows = [
                {
                    'id': row['id'],
                    'displayName': row['display_name'],
                    'uploader': row['username'],
                    'date': row['uploaded_at'],
                    'downloadUrl': '/' + row['path'].lstrip('/'),
                }
                for row in cur.fetchall()
            ]
            return send_json(self, HTTPStatus.OK, rows)

    def api_post_rehearsal_partition(self, rehearsal_id: int, data: bytes, headers, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        if not data:
            return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'File required'})
        content_type = headers.get('Content-Type', '')
        fields, files = parse_multipart_form_data(data, content_type)
        file_field = files.get('file')
        if not file_field or not file_field.get('content'):
            return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'File required'})
        file_bytes = file_field['content']
        if len(file_bytes) > MAX_PARTITION_SIZE:
            return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'File too large'})
        file_name = file_field.get('filename') or ''
        file_type = file_field.get('content_type') or mimetypes.guess_type(file_name)[0]
        if file_type != 'application/pdf' and not file_name.lower().endswith('.pdf'):
            return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid file type'})
        if not file_bytes.startswith(b'%PDF'):
            return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid file type'})
        if not scan_for_viruses(file_bytes):
            return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'File failed antivirus scan'})
        raw_display = fields.get('displayName') or file_name or 'partition.pdf'
        display_name = sanitize_name(raw_display)
        if display_name is None or (file_name and sanitize_name(file_name) is None):
            return send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid file name'})
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT id FROM rehearsals WHERE id = ? AND group_id = ?', (rehearsal_id, user['group_id']))
            if not cur.fetchone():
                return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
            execute_write(cur, 
                'INSERT INTO partitions (rehearsal_id, path, display_name, uploader_id) VALUES (?, ?, ?, ?)',
                (rehearsal_id, '', display_name, user['id']),
            )
            part_id = cur.lastrowid
            rel_path = f'uploads/partitions/{rehearsal_id}/{part_id}.pdf'
            execute_write(cur, 'UPDATE partitions SET path = ? WHERE id = ?', (rel_path, part_id))
            safe_commit(conn)
            dest_dir = os.path.join(UPLOADS_ROOT, str(rehearsal_id))
            os.makedirs(dest_dir, exist_ok=True)
            with open(os.path.join(dest_dir, f'{part_id}.pdf'), 'wb') as f:
                f.write(file_bytes)
            log_event(
                user['id'],
                'partition_upload',
                {'rehearsal_id': rehearsal_id, 'partition_id': part_id, 'display_name': display_name},
            )
            # Send notifications to group members except the uploader
            execute_write(cur,
                '''SELECT u.id FROM users u
                   JOIN memberships m ON m.user_id = u.id
                   WHERE m.group_id = ? AND m.active = 1 AND u.id != ? AND u.notify_uploads = 1''',
                (user['group_id'], user['id']),
            )
            recipients = [row['id'] for row in cur.fetchall()]
            message = f"{user['username']} uploaded {display_name}"
            for uid in recipients:
                execute_write(cur, 'INSERT INTO notifications (user_id, message) VALUES (?, ?)', (uid, message))
            safe_commit(conn)
            return send_json(
                self,
                HTTPStatus.CREATED,
                {
                    'id': part_id,
                    'displayName': display_name,
                    'downloadUrl': '/' + rel_path,
                },
            )

    def api_delete_rehearsal_partition(self, rehearsal_id: int, partition_id: int, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                '''SELECT p.path, p.uploader_id FROM partitions p
                   JOIN rehearsals r ON r.id = p.rehearsal_id
                   WHERE p.id = ? AND p.rehearsal_id = ? AND r.group_id = ?''',
                (partition_id, rehearsal_id, user['group_id']),
            )
            row = cur.fetchone()
            if not row:
                return send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Partition not found'})
            if row['uploader_id'] != user['id'] and role != 'admin':
                return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            execute_write(cur, 'DELETE FROM partitions WHERE id = ?', (partition_id,))
            safe_commit(conn)
            file_path = os.path.join(os.path.dirname(__file__), row['path'])
            try:
                os.remove(file_path)
            except OSError as e:
                logger.warning(
                    "Failed to remove partition file %s", file_path, exc_info=e
                )
            log_event(
                user['id'],
                'partition_delete',
                {'rehearsal_id': rehearsal_id, 'partition_id': partition_id},
            )
            return send_json(self, HTTPStatus.OK, {'message': 'Deleted'})

    def api_move_suggestion_to_rehearsal_id(self, sug_id: int, user: dict):
        """Move a suggestion to rehearsals."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        result = move_suggestion_to_rehearsal(sug_id)
        if result is None:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Suggestion not found'})
        else:
            send_json(self, HTTPStatus.OK, result)

    def api_move_rehearsal_to_suggestion_id(self, reh_id: int, user: dict):
        """Move a rehearsal back to suggestions."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            return send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
        result = move_rehearsal_to_suggestion(reh_id)
        if result is None:
            send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
        else:
            send_json(self, HTTPStatus.OK, result)

    def api_update_performance_id(self, perf_id: int, body: dict, user: dict):
        """Update name, date and songs for a performance if owned by user."""
        name = (body.get('name') or '').strip()
        date = (body.get('date') or '').strip()
        location = (body.get('location') or '').strip()
        songs = body.get('songs') or []
        if not name or not date:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
            return
        try:
            songs_list = [int(s) for s in songs]
        except (TypeError, ValueError):
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            # Allow update if user is creator or has moderator/administrator role
            if user.get('role') in ('admin', 'moderator'):
                execute_write(cur, 
                    'UPDATE performances SET name = ?, date = ?, location = ?, songs_json = ? WHERE id = ? AND group_id = ?',
                    (name, date, location, json.dumps(songs_list), perf_id, user['group_id'])
                )
            else:
                execute_write(cur, 
                    'UPDATE performances SET name = ?, date = ?, location = ?, songs_json = ? WHERE id = ? AND creator_id = ? AND group_id = ?',
                    (name, date, location, json.dumps(songs_list), perf_id, user['id'], user['group_id'])
                )
            updated = cur.rowcount
            safe_commit(conn)
            if updated:
                send_json(self, HTTPStatus.OK, {'message': 'Updated'})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Performance not found or not owned'})

    def api_delete_performance_id(self, perf_id: int, user: dict):
        """Delete a performance by ID.  The performance can be removed by its
        creator or by an administrator."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            if role in ('admin', 'moderator'):
                execute_write(cur, 'DELETE FROM performances WHERE id = ? AND group_id = ?', (perf_id, user['group_id']))
            else:
                execute_write(cur, 'DELETE FROM performances WHERE id = ? AND creator_id = ? AND group_id = ?', (perf_id, user['id'], user['group_id']))
            deleted = cur.rowcount
            safe_commit(conn)
            if deleted:
                log_event(user['id'], 'delete', {'entity': 'performance', 'id': perf_id})
                send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Performance not found or not owned'})

    def api_create_agenda(self, body: dict, user: dict):
        item_type = body.get('type')
        if item_type == 'rehearsal':
            date = (body.get('date') or '').strip()
            location = (body.get('location') or '').strip()
            if not date:
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Date is required'})
                return
            role = verify_group_access(user['id'], user['group_id'])
            if not role:
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
                return
            with get_db_connection() as conn:
                cur = conn.cursor()
                execute_write(cur, 
                    'INSERT INTO rehearsal_events (date, location, group_id, creator_id) VALUES (?, ?, ?, ?)',
                    (date, location, user['group_id'], user['id'])
                )
                reh_id = cur.lastrowid
                safe_commit(conn)
                send_json(self, HTTPStatus.CREATED, {
                    'type': 'rehearsal',
                    'id': reh_id,
                    'date': date,
                    'title': '',
                    'location': location,
                })
                return
        if item_type == 'performance':
            name = (body.get('name') or '').strip()
            date = (body.get('date') or '').strip()
            location = (body.get('location') or '').strip()
            songs = body.get('songs') or []
            if not name or not date:
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
                return
            role = verify_group_access(user['id'], user['group_id'])
            if not role:
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
                return
            try:
                songs_list = [int(s) for s in songs]
            except (TypeError, ValueError):
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
                return
            with get_db_connection() as conn:
                cur = conn.cursor()
                execute_write(cur, 
                    'INSERT INTO performances (name, date, location, songs_json, creator_id, group_id) VALUES (?, ?, ?, ?, ?, ?)',
                    (name, date, location, json.dumps(songs_list), user['id'], user['group_id'])
                )
                perf_id = cur.lastrowid
                safe_commit(conn)
                send_json(self, HTTPStatus.CREATED, {
                    'type': 'performance',
                    'id': perf_id,
                    'date': date,
                    'title': name,
                    'location': location,
                })
                return
        send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid type'})

    def api_update_agenda_id(self, item_id: int, body: dict, user: dict):
        item_type = body.get('type')
        if item_type == 'rehearsal':
            date = (body.get('date') or '').strip()
            location = (body.get('location') or '').strip()
            if not date:
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Date is required'})
                return
            role = verify_group_access(user['id'], user['group_id'])
            if not role:
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
                return
            with get_db_connection() as conn:
                cur = conn.cursor()
                execute_write(cur, 
                    'UPDATE rehearsal_events SET date = ?, location = ? WHERE id = ? AND group_id = ?',
                    (date, location, item_id, user['group_id'])
                )
                if cur.rowcount == 0:
                    send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not permitted to update'})
                    return
                safe_commit(conn)
                execute_write(cur, 'SELECT id, date, location FROM rehearsal_events WHERE id = ?', (item_id,))
                row = cur.fetchone()
                if not row:
                    send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Not found'})
                    return
                send_json(self, HTTPStatus.OK, {
                    'type': 'rehearsal',
                    'id': row['id'],
                    'date': row['date'],
                    'title': '',
                    'location': row['location'],
                })
                return
        if item_type == 'performance':
            name = (body.get('name') or '').strip()
            date = (body.get('date') or '').strip()
            location = (body.get('location') or '').strip()
            songs = body.get('songs') or []
            if not name or not date:
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Name and date are required'})
                return
            role = verify_group_access(user['id'], user['group_id'])
            if not role:
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
                return
            try:
                songs_list = [int(s) for s in songs]
            except (TypeError, ValueError):
                send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid songs list'})
                return
            with get_db_connection() as conn:
                cur = conn.cursor()
                execute_write(cur, 
                    'UPDATE performances SET name = ?, date = ?, location = ?, songs_json = ? WHERE id = ? AND group_id = ?',
                    (name, date, location, json.dumps(songs_list), item_id, user['group_id'])
                )
                if cur.rowcount == 0:
                    send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not permitted to update'})
                    return
                safe_commit(conn)
                execute_write(cur, 'SELECT id, name, date, location FROM performances WHERE id = ?', (item_id,))
                row = cur.fetchone()
                if not row:
                    send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Not found'})
                    return
                send_json(self, HTTPStatus.OK, {
                    'type': 'performance',
                    'id': row['id'],
                    'date': row['date'],
                    'title': row['name'],
                    'location': row['location'],
                })
                return
        send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid type'})

    def api_delete_agenda_id(self, item_id: int, body: dict, user: dict):
        item_type = body.get('type') or ''
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            if item_type == 'rehearsal':
                execute_write(cur, 'DELETE FROM rehearsal_events WHERE id = ? AND group_id = ?', (item_id, user['group_id']))
                if cur.rowcount == 0:
                    send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not permitted to delete'})
                    return
                safe_commit(conn)
                send_json(self, HTTPStatus.OK, {'success': True})
                return
            if item_type == 'performance':
                execute_write(cur, 'DELETE FROM performances WHERE id = ? AND group_id = ?', (item_id, user['group_id']))
                if cur.rowcount == 0:
                    send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not permitted to delete'})
                    return
                safe_commit(conn)
                send_json(self, HTTPStatus.OK, {'success': True})
                return
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'Invalid type'})

    def api_get_agenda(self, query: dict[str, list[str]], user: dict):
        """Return combined rehearsal events and performances for the active
        group.  Supports optional ``start`` and ``end`` query parameters in
        ISO ``YYYY-MM-DD`` (or ``YYYY-MM-DDTHH:MM``) format to filter the
        results."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        # Extract query parameters
        start_param = query.get('start', [None])[0]
        end_param = query.get('end', [None])[0]
        start = (start_param + ('T00:00' if 'T' not in start_param else '')) if start_param else None
        end = (end_param + ('T23:59' if 'T' not in end_param else '')) if end_param else None
        with get_db_connection() as conn:
            cur = conn.cursor()
            # Fetch rehearsal events
            execute_write(cur, 
                'SELECT id, date, location FROM rehearsal_events WHERE group_id = ? ORDER BY date ASC',
                (user['group_id'],),
            )
            rehearsal_rows = [dict(row) for row in cur.fetchall()]
            # Fetch performances
            execute_write(cur, 
                'SELECT id, name, date, location FROM performances WHERE group_id = ? ORDER BY date ASC',
                (user['group_id'],),
            )
            performance_rows = [dict(row) for row in cur.fetchall()]
            items = [
                {
                    'type': 'rehearsal',
                    'date': r['date'],
                    'id': r['id'],
                    'title': '',
                    'location': r['location'],
                }
                for r in rehearsal_rows
            ] + [
                {
                    'type': 'performance',
                    'date': p['date'],
                    'id': p['id'],
                    'title': p['name'],
                    'location': p['location'],
                }
                for p in performance_rows
            ]
            if start:
                items = [i for i in items if i['date'] >= start]
            if end:
                items = [i for i in items if i['date'] <= end]
            items.sort(key=lambda x: x['date'])
            send_json(self, HTTPStatus.OK, items)

    def api_delete_rehearsal_id(self, rehearsal_id: int, user: dict):
        """Delete a rehearsal by ID.  The rehearsal may be removed by its
        creator or by an admin.  When a rehearsal is deleted, any
        performances referencing it will have the rehearsal ID removed
        from their song lists.  If no performances contain the ID, no
        changes occur.  If the user lacks permission or the rehearsal
        does not exist, a 404 is returned."""
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            # Fetch creator_id to check permissions
            execute_write(cur, 'SELECT creator_id FROM rehearsals WHERE id = ? AND group_id = ?', (rehearsal_id, user['group_id']))
            row = cur.fetchone()
            if not row:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Rehearsal not found'})
                return
            creator_id = row['creator_id']
            if not (role in ('admin', 'moderator') or user['id'] == creator_id):
                send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Not allowed to delete rehearsal'})
                return
            # Remove the rehearsal ID from all performances
            execute_write(cur, 'SELECT id, songs_json FROM performances WHERE group_id = ?', (user['group_id'],))
            performances_to_update = []
            for perf in cur.fetchall():
                songs = json.loads(perf['songs_json'] or '[]')
                if rehearsal_id in songs:
                    songs = [sid for sid in songs if sid != rehearsal_id]
                    performances_to_update.append((json.dumps(songs), perf['id']))
            for songs_json, perf_id in performances_to_update:
                execute_write(cur, 'UPDATE performances SET songs_json = ? WHERE id = ?', (songs_json, perf_id))
            # Now delete the rehearsal itself
            execute_write(cur, 'DELETE FROM rehearsals WHERE id = ? AND group_id = ?', (rehearsal_id, user['group_id']))
            deleted = cur.rowcount
            safe_commit(conn)
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
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            if role in ('admin', 'moderator'):
                execute_write(cur, 'DELETE FROM performances WHERE id = ? AND group_id = ?', (perf_id, user['group_id']))
            else:
                execute_write(cur, 'DELETE FROM performances WHERE id = ? AND creator_id = ? AND group_id = ?', (perf_id, user['id'], user['group_id']))
            deleted = cur.rowcount
            safe_commit(conn)
            if deleted:
                log_event(user['id'], 'delete', {'entity': 'performance', 'id': perf_id})
                send_json(self, HTTPStatus.OK, {'message': 'Deleted'})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'Performance not found or not owned'})

    def api_get_logs(self):
        """Return recent log entries."""
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
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
            send_json(self, HTTPStatus.OK, rows)

    def api_get_settings(self, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 
                'SELECT group_name, dark_mode, template FROM settings WHERE group_id = ?',
                (user['group_id'],),
            )
            row = cur.fetchone()
            if not row:
                # Create default settings row if missing
                execute_write(cur, 'SELECT name FROM groups WHERE id = ?', (user['group_id'],))
                g = cur.fetchone()
                group_name = g['name'] if g else ''
                execute_write(cur, 
                    "INSERT INTO settings (group_id, group_name, dark_mode, template) VALUES (?, ?, 1, 'classic')",
                    (user['group_id'], group_name),
                )
                safe_commit(conn)
                row = {
                    'group_name': group_name,
                    'dark_mode': 1,
                    'template': 'classic',
                }
            else:
                row = dict(row)
            send_json(self, HTTPStatus.OK, {
                'groupName': row['group_name'],
                'darkMode': bool(row['dark_mode']),
                'template': row['template'] or 'classic',
            })

    def api_update_settings(self, body: dict, user: dict):
        role = verify_group_access(user['id'], user['group_id'], 'admin')
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        group_name = (body.get('groupName') or '').strip()
        dark_mode = body.get('darkMode')
        template = body.get('template')
        if not group_name or dark_mode is None:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'groupName and darkMode are required'})
            return
        # If template is provided, ensure it is a non-empty string
        if template is not None:
            template = (str(template).strip() or 'classic')
        with get_db_connection() as conn:
            cur = conn.cursor()
            if template is None:
                execute_write(cur, 
                    'UPDATE settings SET group_name = ?, dark_mode = ? WHERE group_id = ?',
                    (group_name, 1 if bool(dark_mode) else 0, user['group_id'])
                )
            else:
                execute_write(cur, 
                    'UPDATE settings SET group_name = ?, dark_mode = ?, template = ? WHERE group_id = ?',
                    (group_name, 1 if bool(dark_mode) else 0, template, user['group_id'])
                )
            execute_write(cur, 
                'UPDATE groups SET name = ? WHERE id = ?',
                (group_name, user['group_id'])
            )
            safe_commit(conn)
            send_json(self, HTTPStatus.OK, {'message': 'Settings updated'})

    def api_get_user_settings(self, user: dict):
        if not user:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT notify_uploads FROM users WHERE id = ?', (user['id'],))
            row = cur.fetchone()
            send_json(self, HTTPStatus.OK, {'notifyUploads': bool(row['notify_uploads'])})

    def api_update_user_settings(self, body: dict, user: dict):
        if not user:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
            return
        notify = body.get('notifyUploads')
        if notify is None:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'notifyUploads is required'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'UPDATE users SET notify_uploads = ? WHERE id = ?', (1 if bool(notify) else 0, user['id']))
            safe_commit(conn)
            send_json(self, HTTPStatus.OK, {'message': 'Settings updated'})

    def api_push_subscribe(self, body: dict, user: dict):
        if not user:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
            return
        endpoint = body.get('endpoint')
        p256dh = body.get('p256dh')
        auth = body.get('auth')
        unsubscribe = body.get('unsubscribe')
        if not endpoint:
            send_json(self, HTTPStatus.BAD_REQUEST, {'error': 'endpoint required'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            if unsubscribe:
                execute_write(cur,
                    'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?',
                    (endpoint, user['id']),
                )
                safe_commit(conn)
                send_json(self, HTTPStatus.OK, {'status': 'unsubscribed'})
            else:
                execute_write(cur,
                    'INSERT OR REPLACE INTO push_subscriptions (endpoint, p256dh, auth, user_id) VALUES (?, ?, ?, ?)',
                    (endpoint, p256dh, auth, user['id']),
                )
                safe_commit(conn)
                send_json(self, HTTPStatus.OK, {'status': 'subscribed'})

    def api_get_notifications(self, user: dict):
        if not user:
            send_json(self, HTTPStatus.UNAUTHORIZED, {'error': 'Not authenticated'})
            return
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT id, message, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC', (user['id'],))
            rows = [
                {'id': row['id'], 'message': row['message'], 'date': row['created_at']}
                for row in cur.fetchall()
            ]
            send_json(self, HTTPStatus.OK, rows)

    def api_repertoire_pdf(self, user: dict):
        role = verify_group_access(user['id'], user['group_id'])
        if not role:
            send_json(self, HTTPStatus.FORBIDDEN, {'error': 'Forbidden'})
            return
        if canvas is None:
            send_json(
                self,
                HTTPStatus.INTERNAL_SERVER_ERROR,
                {'error': 'PDF export requires reportlab. Install dependencies with "pip install -r requirements.txt".'},
            )
            return
        buffer = io.BytesIO()
        pdf = canvas.Canvas(buffer, pagesize=A4)
        width, height = A4
        y = height - 40
        pdf.setFont("Helvetica", 12)
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur,
                'SELECT title, author FROM rehearsals WHERE group_id = ? ORDER BY title',
                (user['group_id'],)
            )
            for row in cur.fetchall():
                line = row['title']
                if row['author']:
                    line += f" - {row['author']}"
                pdf.drawString(40, y, line)
                y -= 20
                if y < 40:
                    pdf.showPage()
                    pdf.setFont("Helvetica", 12)
                    y = height - 40
        pdf.save()
        data = buffer.getvalue()
        self.send_response(HTTPStatus.OK)
        self.send_header('Content-Type', 'application/pdf')
        self.send_header('Content-Disposition', 'attachment; filename="repertoire.pdf"')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    # ------------------------------------------------------------------
    # Users management (admin only)

    def api_get_users(self):
        """Return a list of all users with their admin status.  Accessible
        only to administrators."""
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'SELECT id, username, role FROM users ORDER BY username ASC')
            users = []
            for row in cur.fetchall():
                users.append({
                    'id': row['id'],
                    'username': row['username'],
                    'role': row['role'],
                })
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
        with get_db_connection() as conn:
            cur = conn.cursor()
            execute_write(cur, 'UPDATE users SET role = ? WHERE id = ?', (role, uid))
            execute_write(cur, 'UPDATE memberships SET role = ? WHERE user_id = ?', (role, uid))
            updated = cur.rowcount
            safe_commit(conn)
            if updated:
                log_event(current_user['id'], 'role_change', {'targetUserId': uid, 'newRole': role})
                send_json(self, HTTPStatus.OK, {'message': 'User updated'})
            else:
                send_json(self, HTTPStatus.NOT_FOUND, {'error': 'User not found'})

#############################
# Server entry point
#############################

def run_server(host: str = '0.0.0.0', port: int = 8080):
    init_db()
    threading.Thread(target=start_ws_server, args=(host, port), daemon=True).start()
    server = ThreadingHTTPServer((host, port), BandTrackHandler)
    print(f"BandTrack server running on http://{host}:{port} (Ctrl-C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Run BandTrack backend server.')
    parser.add_argument('--port', type=int, default=int(os.environ.get('PORT', 8080)), help='Port to bind the server on')
    parser.add_argument('--host', type=str, default=os.environ.get('HOST', '0.0.0.0'), help='Host/IP to bind the server on')
    args = parser.parse_args()
    run_server(args.host, args.port)
