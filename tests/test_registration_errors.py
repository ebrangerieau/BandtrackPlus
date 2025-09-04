import json
import sqlite3
from unittest import mock

from test_api import start_test_server, stop_test_server, request


def test_duplicate_user_returns_conflict(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        status, _, _ = request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        assert status == 200
        status, _, body = request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        assert status == 409
        assert json.loads(body)["error"] == "User already exists"
    finally:
        stop_test_server(httpd, thread)


def test_register_db_failure_returns_500(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        with mock.patch("bandtrack.api.get_db_connection", side_effect=sqlite3.OperationalError):
            status, _, body = request("POST", port, "/api/register", {"username": "bob", "password": "pw"})
        assert status == 500
        assert json.loads(body) == {"error": "Registration failed"}
    finally:
        stop_test_server(httpd, thread)
