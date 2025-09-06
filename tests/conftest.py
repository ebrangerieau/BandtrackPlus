import os
import pytest
from testcontainers.postgres import PostgresContainer

try:
    pg = PostgresContainer("postgres:15")
    pg.start()
    os.environ["DATABASE_URL"] = pg.get_connection_url()
    import bandtrack.api as server
    server.init_db()
    _docker_ready = True
except Exception:  # pragma: no cover - handled during testing
    pg = None
    server = None  # type: ignore
    _docker_ready = False


@pytest.fixture(scope="session", autouse=True)
def _stop_container():
    if pg is not None:
        yield
        pg.stop()
    else:
        yield


@pytest.fixture(autouse=True)
def reset_db(request):
    if not _docker_ready:
        # Allow tests marked with "nodb" to run even when PostgreSQL is
        # unavailable.  This is useful for unit tests that do not require a
        # real database connection.
        if "nodb" in request.keywords:
            return
        pytest.skip("PostgreSQL container not available")
    with server.get_db_connection() as conn:  # type: ignore[union-attr]
        cur = conn.cursor()
        cur.execute("DROP SCHEMA public CASCADE")
        cur.execute("CREATE SCHEMA public")
        conn.commit()
    server.init_db()  # type: ignore[union-attr]
