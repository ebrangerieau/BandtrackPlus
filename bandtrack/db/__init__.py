import os
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


#############################
# Database helpers
#############################


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


def execute_write(target, sql, params=()):
    """Execute a SQL statement."""
    try:
        result = target.execute(sql, params)
    except Psycopg2Error:
        target.connection.rollback()
        raise
    if sql.lstrip().upper().startswith("INSERT") and not getattr(target, "lastrowid", None):
        target.execute("SELECT LASTVAL()")
        target.lastrowid = target.fetchone()[0]
    return result


def safe_commit(conn):
    """Commit the current transaction, rolling back on failure."""
    try:
        conn.commit()
    except Psycopg2Error:
        conn.rollback()
        raise


@contextmanager
def get_db_connection():
    """Yield a database connection."""
    if psycopg2 is None:
        raise RuntimeError("PostgreSQL support requires installing psycopg2")
    conn = psycopg2.connect(_pg_dsn(), cursor_factory=psycopg2_extras.RealDictCursor)
    try:
        yield conn
        safe_commit(conn)
    finally:
        conn.close()


def open_db_connection():
    """Return a new database connection."""
    if psycopg2 is None:
        raise RuntimeError("PostgreSQL support requires installing psycopg2")
    return psycopg2.connect(_pg_dsn(), cursor_factory=psycopg2_extras.RealDictCursor)


class PartitionDAO:
    """Data access helper for the partitions table."""

    def __init__(self, conn):
        self.conn = conn

    def create(self, rehearsal_id: int, path: str, display_name: str, uploader_id: int) -> int:
        cur = self.conn.cursor()
        execute_write(
            cur,
            'INSERT INTO partitions (rehearsal_id, path, display_name, uploader_id) VALUES (%s, %s, %s, %s)',
            (rehearsal_id, path, display_name, uploader_id),
        )
        safe_commit(self.conn)
        return cur.lastrowid

    def list_by_rehearsal(self, rehearsal_id: int) -> list:
        cur = self.conn.cursor()
        execute_write(cur, 'SELECT * FROM partitions WHERE rehearsal_id = %s', (rehearsal_id,))
        return cur.fetchall()

    def delete(self, partition_id: int) -> None:
        cur = self.conn.cursor()
        execute_write(cur, 'DELETE FROM partitions WHERE id = %s', (partition_id,))
        safe_commit(self.conn)


def get_partition_dao(conn) -> PartitionDAO:
    return PartitionDAO(conn)


def init_db():
    """Create tables if they do not already exist and insert the
    default settings row.  This function is idempotent."""
    admin_password = os.environ.get("ADMIN_PASSWORD")
    from bandtrack.auth import hash_password

    with get_db_connection() as conn:
        cur = conn.cursor()

        def run(stmt: str) -> None:
            execute_write(cur, stmt)

        # Groups allow multiple band configurations and are owned by a user
        run(
            '''CREATE TABLE IF NOT EXISTS groups (
                   id SERIAL PRIMARY KEY,
                   name TEXT NOT NULL,
                   invitation_code TEXT NOT NULL UNIQUE,
                   description TEXT,
                   logo_url TEXT,
                   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                   owner_id INTEGER NOT NULL
               );'''
        )

        # Users table: store username, salt and password hash
        run(
            '''CREATE TABLE IF NOT EXISTS users (
                   id SERIAL PRIMARY KEY,
                   username TEXT NOT NULL UNIQUE,
                   salt BYTEA NOT NULL,
                   password_hash BYTEA NOT NULL,
                   role TEXT NOT NULL DEFAULT 'user',
                   last_group_id INTEGER,
                   notify_uploads INTEGER NOT NULL DEFAULT 1,
                   FOREIGN KEY (last_group_id) REFERENCES groups(id)
               );'''
        )
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
                   id SERIAL PRIMARY KEY,
                   user_id INTEGER NOT NULL,
                   credential_id TEXT NOT NULL UNIQUE,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )

        # Suggestions: simple list of suggestions with optional URL and creator
        run(
            '''CREATE TABLE IF NOT EXISTS suggestions (
                   id SERIAL PRIMARY KEY,
                   title TEXT NOT NULL,
                   author TEXT,
                   youtube TEXT,
                   url TEXT,
                   version_of TEXT,
                   likes INTEGER NOT NULL DEFAULT 0,
                   creator_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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

        # Rehearsals
        run(
            '''CREATE TABLE IF NOT EXISTS rehearsals (
                   id SERIAL PRIMARY KEY,
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
                   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (creator_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )

        run(
            '''CREATE TABLE IF NOT EXISTS rehearsal_events (
                   id SERIAL PRIMARY KEY,
                   rehearsal_id INTEGER,
                   name TEXT NOT NULL,
                   date TIMESTAMP,
                   location TEXT,
                   group_id INTEGER NOT NULL,
                   FOREIGN KEY (rehearsal_id) REFERENCES rehearsals(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )

        # Performances
        run(
            '''CREATE TABLE IF NOT EXISTS performances (
                   id SERIAL PRIMARY KEY,
                   name TEXT NOT NULL,
                   date TIMESTAMP,
                   location TEXT,
                   songs_json TEXT NOT NULL DEFAULT '[]',
                   creator_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (creator_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )

        # Sessions
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

        # Memberships
        run(
            '''CREATE TABLE IF NOT EXISTS memberships (
                   id SERIAL PRIMARY KEY,
                   user_id INTEGER NOT NULL,
                   group_id INTEGER NOT NULL,
                   role TEXT NOT NULL DEFAULT 'user',
                   nickname TEXT,
                   joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                   active INTEGER NOT NULL DEFAULT 1,
                   UNIQUE(user_id, group_id),
                   FOREIGN KEY (user_id) REFERENCES users(id),
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )

        # Logs
        run(
            '''CREATE TABLE IF NOT EXISTS logs (
                   id SERIAL PRIMARY KEY,
                   user_id INTEGER,
                   action TEXT NOT NULL,
                   metadata TEXT,
                   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )

        # Settings
        run(
            '''CREATE TABLE IF NOT EXISTS settings (
                   id SERIAL PRIMARY KEY,
                   group_id INTEGER NOT NULL UNIQUE,
                   group_name TEXT NOT NULL,
                   dark_mode INTEGER NOT NULL DEFAULT 1,
                   template TEXT,
                   FOREIGN KEY (group_id) REFERENCES groups(id)
               );'''
        )

        # Notifications
        run(
            '''CREATE TABLE IF NOT EXISTS notifications (
                   id SERIAL PRIMARY KEY,
                   user_id INTEGER NOT NULL,
                   message TEXT NOT NULL,
                   created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )

        # Push subscriptions
        run(
            '''CREATE TABLE IF NOT EXISTS push_subscriptions (
                   endpoint TEXT PRIMARY KEY,
                   p256dh TEXT NOT NULL,
                   auth TEXT NOT NULL,
                   user_id INTEGER NOT NULL,
                   FOREIGN KEY (user_id) REFERENCES users(id)
               );'''
        )

        # Determine if admin user exists
        execute_write(cur, 'SELECT id, salt, password_hash FROM users WHERE username = %s', ('admin',))
        row = cur.fetchone()
        if row is None:
            if not admin_password:
                alphabet = string.ascii_letters + string.digits
                admin_password = ''.join(secrets.choice(alphabet) for _ in range(12))
                print(f"Generated admin password: {admin_password}")
            salt, pwd_hash = hash_password(admin_password)
            execute_write(
                cur,
                'INSERT INTO users (username, salt, password_hash) VALUES (%s, %s, %s)',
                ('admin', salt, pwd_hash),
            )
            execute_write(cur, "INSERT INTO groups (name, invitation_code, owner_id) VALUES ('Default', 'DEF123', 1)")
            execute_write(cur,
                "INSERT INTO settings (id, group_name, dark_mode, template, group_id) VALUES (1, 'Band', 0, 'classic', 1)"
            )
        else:
            if bytes(row['salt']) == b'\x00' or bytes(row['password_hash']) == b'\x00':
                if admin_password:
                    salt, pwd_hash = hash_password(admin_password)
                    execute_write(
                        cur,
                        'UPDATE users SET salt = %s, password_hash = %s WHERE username = %s',
                        (salt, pwd_hash, 'admin'),
                    )
                else:
                    raise RuntimeError('ADMIN_PASSWORD environment variable must be set for initial admin password')

#############################
# Helper functions
#############################
