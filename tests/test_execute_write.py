import pytest
from bandtrack.db import execute_write


class FakeConn:
    def rollback(self):
        pass


class FakeCursor:
    def __init__(self):
        self.lastrowid = None
        self.connection = FakeConn()
        self.calls = []

    def execute(self, sql, params=()):
        # Record executed SQL for debugging
        self.calls.append((sql, params))

    def fetchone(self):
        return {"lastval": 123}

@pytest.mark.nodb
def test_execute_write_sets_lastrowid_from_mapping_row():
    cur = FakeCursor()
    execute_write(cur, "INSERT INTO dummy DEFAULT VALUES")
    assert cur.lastrowid == 123
    # Ensure SELECT LASTVAL() was executed after the INSERT
    assert cur.calls[-1][0] == "SELECT LASTVAL()"
