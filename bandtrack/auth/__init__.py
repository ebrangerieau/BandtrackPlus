import json
import os
import secrets
import string
import hashlib
import hmac
import time

from bandtrack.db import get_db_connection, execute_write, safe_commit


def hash_password(password: str, salt: bytes | None = None) -> tuple[bytes, bytes]:
    """Hash a password with PBKDF2. If ``salt`` is None, a new salt is generated."""
    if salt is None:
        salt = os.urandom(16)
    hashed = hashlib.pbkdf2_hmac('sha256', password.encode('utf-8'), salt, 100_000)
    return salt, hashed


def verify_password(password: str, salt: bytes, expected_hash: bytes) -> bool:
    """Verify a password against a stored salt and hash."""
    _, hashed = hash_password(password, salt)
    return hmac.compare_digest(hashed, expected_hash)


def generate_invitation_code(length: int = 6) -> str:
    alphabet = string.ascii_uppercase + string.digits
    return ''.join(secrets.choice(alphabet) for _ in range(length))


def generate_unique_invitation_code() -> str:
    with get_db_connection() as conn:
        cur = conn.cursor()
        while True:
            code = generate_invitation_code()
            execute_write(cur, 'SELECT 1 FROM groups WHERE invitation_code = ?', (code,))
            if cur.fetchone() is None:
                return code


def generate_session(user_id: int, group_id: int | None, duration_seconds: int = 7 * 24 * 3600) -> str:
    token = secrets.token_hex(32)
    expires_at = int(time.time()) + duration_seconds
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur,
            'INSERT INTO sessions (token, user_id, group_id, expires_at) VALUES (?, ?, ?, ?)',
            (token, user_id, group_id, expires_at)
        )
        safe_commit(conn)
    return token


def get_user_by_session(token: str) -> dict | None:
    if not token:
        return None
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 'DELETE FROM sessions WHERE expires_at <= ?', (int(time.time()),))
        execute_write(cur,
            'SELECT user_id, group_id FROM sessions WHERE token = ?',
            (token,)
        )
        row = cur.fetchone()
        if not row:
            safe_commit(conn)
            return None
        user_id = row['user_id']
        group_id = row['group_id']
        new_expires = int(time.time()) + 7 * 24 * 3600
        execute_write(cur,
            'UPDATE sessions SET expires_at = ? WHERE token = ?',
            (new_expires, token)
        )
        execute_write(cur,
            'SELECT id, username, role FROM users WHERE id = ?',
            (user_id,)
        )
        user_row = cur.fetchone()
        safe_commit(conn)
    if user_row:
        return {
            'id': user_row['id'],
            'username': user_row['username'],
            'role': user_row['role'],
            'group_id': group_id,
        }
    return None


def delete_session(token: str) -> None:
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur, 'DELETE FROM sessions WHERE token = ?', (token,))
        safe_commit(conn)


def log_event(user_id: int | None, action: str, metadata: dict | None = None) -> None:
    with get_db_connection() as conn:
        cur = conn.cursor()
        execute_write(cur,
            'INSERT INTO logs (user_id, action, metadata) VALUES (?, ?, ?)',
            (user_id, action, json.dumps(metadata or {}))
        )
        safe_commit(conn)
