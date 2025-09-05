import os
import time
import sqlite3
import secrets
import string
from contextlib import contextmanager
try:
    import psycopg2  # type: ignore
    import psycopg2.extras as psycopg2_extras  # type: ignore
    Psycopg2Error = psycopg2.Error  # type: ignore[attr-defined]
except ModuleNotFoundError:  # pragma: no cover - optional dependency
    psycopg2 = None  # type: ignore
    psycopg2_extras = None  # type: ignore
    class Psycopg2Error(Exception):
        pass
import sqlparse
from sqlparse import tokens as T

# Path to the SQLite database when Postgres is not configured
DB_FILENAME = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'bandtrack.db')


#############################
# Database helpers
#############################


def _using_postgres() -> bool:
    """Return True if a PostgreSQL DSN is configured."""
    return bool(
        os.environ.get("DATABASE_URL")
        or os.environ.get("DB_HOST")
    )


def _pg_dsn() -> str:
    """Build a PostgreSQL connection string from environment variables."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    host = os.environ.get("DB_HOST", "localhost")
    port = os.environ.get("DB_PORT", "5432")
    user = os.environ.get("DB_USER", "postgres")
    password = os.environ.get("DB_PASSWORD", "")
    dbname = os.environ.get("DB_NAME", "postgres")
    return f"postgresql://{user}:{password}@{host}:{port}/{dbname}"


def to_psycopg2_params(query: str, params: tuple) -> tuple[str, tuple]:
    """Convert SQLite-style '?' placeholders to psycopg2 parameters.

    Uses ``sqlparse`` to avoid replacing question marks that appear inside
    string literals or comments. Raises ``ValueError`` if the number of
    placeholders does not match ``params``.
    """
    parsed = sqlparse.parse(query)
    if not parsed:
        return query, params
    tokens: list[str] = []
    count = 0
    for token in parsed[0].flatten():
        if token.ttype == T.Name.Placeholder and token.value == "?":
            tokens.append("%s")
            count += 1
        else:
            tokens.append(token.value)
    if count != len(params):
        raise ValueError("Mismatched number of parameters")
    return "".join(tokens), params


def execute_write(target, sql, params=()):
    """Execute a SQL statement with retry on database locks."""
    if _using_postgres():
        sql, params = to_psycopg2_params(sql, params)
        try:
            result = target.execute(sql, params)
        except Psycopg2Error:
            target.connection.rollback()
            raise
        if sql.lstrip().upper().startswith("INSERT") and not getattr(target, "lastrowid", None):
            target.execute("SELECT LASTVAL()"); target.lastrowid = target.fetchone()[0]
        return result
    delay = 0.05
    for attempt in range(5):
        try:
            return target.execute(sql, params)
        except sqlite3.OperationalError as e:
            if "database is locked" in str(e).lower() and attempt < 4:
                time.sleep(delay)
                delay *= 2
                continue
            raise


def safe_commit(conn):
    """Commit the current transaction, rolling back on failure."""
    if _using_postgres():
        try:
            conn.commit()
        except Psycopg2Error:
            conn.rollback()
            raise
    else:
        conn.commit()


@contextmanager
def get_db_connection():
    """Yield a database connection with foreign keys enabled."""
    if _using_postgres():
        if psycopg2 is None:
            raise RuntimeError("PostgreSQL support requires installing psycopg2")
        conn = psycopg2.connect(_pg_dsn(), cursor_factory=psycopg2_extras.RealDictCursor)
    else:
        conn = sqlite3.connect(DB_FILENAME, check_same_thread=False, timeout=30)
        execute_write(conn, 'PRAGMA foreign_keys = ON')
        execute_write(conn, 'PRAGMA journal_mode=WAL')
        execute_write(conn, 'PRAGMA busy_timeout=30000')
        conn.row_factory = sqlite3.Row
    try:
        yield conn
        safe_commit(conn)
    finally:
        conn.close()


def open_db_connection():
    """Return a new database connection with the standard settings applied."""
    if _using_postgres():
        if psycopg2 is None:
            raise RuntimeError("PostgreSQL support requires installing psycopg2")
        return psycopg2.connect(_pg_dsn(), cursor_factory=psycopg2_extras.RealDictCursor)
    conn = sqlite3.connect(DB_FILENAME, check_same_thread=False, timeout=30)
    execute_write(conn, 'PRAGMA foreign_keys = ON')
    execute_write(conn, 'PRAGMA journal_mode=WAL')
    execute_write(conn, 'PRAGMA busy_timeout=30000')
    conn.row_factory = sqlite3.Row
    return conn


class PartitionDAO:
    """Data access helper for the partitions table."""

    def __init__(self, conn):
        self.conn = conn

    def create(self, rehearsal_id: int, path: str, display_name: str, uploader_id: int) -> int:
        cur = self.conn.cursor()
        execute_write(cur,
            'INSERT INTO partitions (rehearsal_id, path, display_name, uploader_id) VALUES (?, ?, ?, ?)',
            (rehearsal_id, path, display_name, uploader_id),
        )
        safe_commit(self.conn)
        return cur.lastrowid

    def list_by_rehearsal(self, rehearsal_id: int) -> list:
        cur = self.conn.cursor()
        execute_write(cur, 'SELECT * FROM partitions WHERE rehearsal_id = ?', (rehearsal_id,))
        return cur.fetchall()

    def delete(self, partition_id: int) -> None:
        cur = self.conn.cursor()
        execute_write(cur, 'DELETE FROM partitions WHERE id = ?', (partition_id,))
        safe_commit(self.conn)


def get_partition_dao(conn: sqlite3.Connection) -> PartitionDAO:
    return PartitionDAO(conn)


def init_db():
    """Create tables if they do not already exist and insert the
    default settings row.  This function is idempotent."""
    new_db = (not _using_postgres()) and not os.path.exists(DB_FILENAME)
    admin_password = os.environ.get("ADMIN_PASSWORD")
    from bandtrack.auth import hash_password
    with get_db_connection() as conn:
        cur = conn.cursor()

        def run(stmt: str) -> None:
            if _using_postgres():
                stmt = (
                    stmt.replace("INTEGER PRIMARY KEY AUTOINCREMENT", "SERIAL PRIMARY KEY")
                    .replace("BLOB", "BYTEA")
                    .replace("DATETIME", "TIMESTAMP")
                )
            execute_write(cur, stmt)

        # Groups allow multiple band configurations and are owned by a user
        groups_stmt = (
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
        if _using_postgres():
            groups_stmt = groups_stmt.replace(
                ',\n                   FOREIGN KEY (owner_id) REFERENCES users(id)',
                '',
            )
        run(groups_stmt)

        # Users table: store username, salt and password hash
        run(
            '''CREATE TABLE IF NOT EXISTS users (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   username TEXT NOT NULL UNIQUE,
                   salt BLOB NOT NULL,
                   password_hash BLOB NOT NULL,
                   role TEXT NOT NULL DEFAULT 'user',
                   last_group_id INTEGER,
                   notify_uploads INTEGER NOT NULL DEFAULT 1,
                   FOREIGN KEY (last_group_id) REFERENCES groups(id)
               );'''
        )
        if _using_postgres():
            try:
                run(
                    'ALTER TABLE groups ADD CONSTRAINT fk_groups_owner '
                    'FOREIGN KEY (owner_id) REFERENCES users(id)'
                )
            except Exception:
                pass
        # WebAuthn credentials associated with users
        run(
            '''CREATE TABLE IF NOT EXISTS users_webauthn (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   user_id INTEGER NOT NULL,
                   credential_id TEXT NOT NULL UNIQUE,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )
        # Suggestions: simple list of suggestions with optional URL and creator
        run(
            '''CREATE TABLE IF NOT EXISTS suggestions (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   title TEXT NOT NULL,
                   author TEXT,
                   youtube TEXT,
                   url TEXT,
                   version_of TEXT,
                   likes INTEGER NOT NULL DEFAULT 0,
                   creator_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (creator_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        # Individual suggestion votes per user
        run(
            '''CREATE TABLE IF NOT EXISTS suggestion_votes (
                   suggestion_id INTEGER NOT NULL,
                   user_id INTEGER NOT NULL,
                   PRIMARY KEY (suggestion_id, user_id),
                   FOREIGN KEY (suggestion_id) REFERENCES suggestions(id),
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )
        # Rehearsals: store levels and notes per user as JSON strings.  Include
        # optional author, YouTube/Spotify links and audio notes JSON.  The
        # creator_id denotes the user who created the rehearsal.
        run(
            '''CREATE TABLE IF NOT EXISTS rehearsals (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   title TEXT NOT NULL,
                   author TEXT,
                   youtube TEXT,
                   spotify TEXT,
                   version_of TEXT,
                   levels_json TEXT NOT NULL DEFAULT '{}',
                   notes_json TEXT NOT NULL DEFAULT '{}',
                   audio_notes_json TEXT NOT NULL DEFAULT '{}',
                   mastered INTEGER NOT NULL DEFAULT 0,
                   creator_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (creator_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        run(
            '''CREATE TABLE IF NOT EXISTS rehearsal_events (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   rehearsal_id INTEGER,
                   name TEXT NOT NULL,
                   date DATETIME,
                   location TEXT,
                   group_id INTEGER NOT NULL,
                   FOREIGN KEY (rehearsal_id) REFERENCES rehearsals(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        # Performances: list of performances with songs stored as JSON
        run(
            '''CREATE TABLE IF NOT EXISTS performances (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   name TEXT NOT NULL,
                   date DATETIME,
                   location TEXT,
                   songs_json TEXT NOT NULL DEFAULT '[]',
                   creator_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (creator_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        # Sessions: active user sessions with expiry timestamps
        run(
            '''CREATE TABLE IF NOT EXISTS sessions (
                   token TEXT PRIMARY KEY,
                   user_id INTEGER NOT NULL,
                   group_id INTEGER,
                   expires_at INTEGER NOT NULL,
                   FOREIGN KEY (user_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        # Memberships: which users belong to which groups
        run(
            '''CREATE TABLE IF NOT EXISTS memberships (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   user_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   role TEXT NOT NULL DEFAULT 'user',
                   nickname TEXT,
                   joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                   active INTEGER NOT NULL DEFAULT 1,
                   UNIQUE(user_id, group_id),
                   FOREIGN KEY (user_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        # Logs: record user actions for auditing
        run(
            '''CREATE TABLE IF NOT EXISTS logs (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   user_id INTEGER,
                   action TEXT NOT NULL,
                   metadata TEXT,
                   created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )
        # Settings: per-group configuration such as name, theme and template
        run(
            '''CREATE TABLE IF NOT EXISTS settings (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   group_id INTEGER NOT NULL UNIQUE,
                   group_name TEXT NOT NULL,
                   dark_mode INTEGER NOT NULL DEFAULT 1,
                   template TEXT,
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )
        # Notifications: simple user-facing messages
        run(
            '''CREATE TABLE IF NOT EXISTS notifications (
                   id INTEGER PRIMARY KEY AUTOINCREMENT,
                   user_id INTEGER NOT NULL,
                   message TEXT NOT NULL,
                   created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )
        # Push subscriptions for Web Push notifications
        run(
            '''CREATE TABLE IF NOT EXISTS push_subscriptions (
                   endpoint TEXT PRIMARY KEY,
                   p256dh TEXT NOT NULL,
                   auth TEXT NOT NULL,
                   user_id INTEGER NOT NULL,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )
        if new_db:
            # Insert default user, group and settings row
            if not admin_password:
                alphabet = string.ascii_letters + string.digits
                admin_password = ''.join(secrets.choice(alphabet) for _ in range(12))
                print(f"Generated admin password: {admin_password}")
            salt, pwd_hash = hash_password(admin_password)
            execute_write(cur,
                'INSERT INTO users (username, salt, password_hash) VALUES (?, ?, ?)',
                ('admin', salt, pwd_hash)
            )
            execute_write(cur, 'INSERT INTO groups (name, invitation_code, owner_id) VALUES ("Default", "DEF123", 1)')
            execute_write(cur,
                'INSERT INTO settings (id, group_name, dark_mode, template, group_id) VALUES (1, "Band", 0, "classic", 1)'
            )
        else:
            execute_write(cur, 'SELECT salt, password_hash FROM users WHERE username = ?', ('admin',))
            row = cur.fetchone()
            if row and (bytes(row['salt']) == b'\x00' or bytes(row['password_hash']) == b'\x00'):
                if admin_password:
                    salt, pwd_hash = hash_password(admin_password)
                    execute_write(cur,
                        'UPDATE users SET salt = ?, password_hash = ? WHERE username = ?',
                        (salt, pwd_hash, 'admin')
                    )
                else:
                    raise RuntimeError('ADMIN_PASSWORD environment variable must be set for initial admin password')

    # Migrations to adjust existing databases
    from scripts.migrate_to_multigroup import migrate as migrate_to_multigroup
    from scripts.migrate_suggestion_votes import migrate as migrate_suggestion_votes
    from scripts.migrate_performance_location import migrate as migrate_performance_location
    from scripts.migrate_sessions_group_id import migrate as migrate_sessions_group_id

    # Run migrations that operate on a given database file
    migrate_to_multigroup(DB_FILENAME)
    migrate_suggestion_votes(DB_FILENAME)
    migrate_performance_location(DB_FILENAME)
    migrate_sessions_group_id(DB_FILENAME)

    # Ensure the sessions table has a column for group_id, required to track the
    # group for a session.
    conn = None
    try:
        conn = open_db_connection()
        cur = conn.cursor()
        execute_write(cur, 'PRAGMA table_info(sessions)')
        sess_columns = [row['name'] for row in cur.fetchall()]
        if 'group_id' not in sess_columns:
            execute_write(cur, 'ALTER TABLE sessions ADD COLUMN group_id INTEGER')
        safe_commit(conn)
    except Exception:
        pass
    finally:
        if conn is not None:
            conn.close()

#############################
# Helper functions
#############################
