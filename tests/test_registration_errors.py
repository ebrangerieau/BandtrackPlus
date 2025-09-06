import concurrent.futures
import json
import psycopg2
from unittest import mock

from test_api import start_test_server, stop_test_server, request


def test_duplicate_user_returns_conflict():
    httpd, thread, port = start_test_server()
    try:
        status, _, _ = request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        assert status == 200
        status, _, body = request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        assert status == 409
        assert json.loads(body)["error"] == "User already exists"
    finally:
        stop_test_server(httpd, thread)


def test_simultaneous_duplicate_user_returns_conflict():
    httpd, thread, port = start_test_server()
    try:
        def register():
            return request("POST", port, "/api/register", {"username": "alice", "password": "pw"})

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(register) for _ in range(2)]
            results = [f.result() for f in futures]

        statuses = sorted(r[0] for r in results)
        assert statuses == [200, 409]
        error_body = json.loads(next(r[2] for r in results if r[0] == 409))
        assert error_body["error"] == "User already exists"
    finally:
        stop_test_server(httpd, thread)


def test_register_db_failure_returns_503():
    httpd, thread, port = start_test_server()
    try:
        with mock.patch(
            "bandtrack.api.get_db_connection",
            side_effect=psycopg2.OperationalError("boom"),
        ):
            status, _, body = request("POST", port, "/api/register", {"username": "bob", "password": "pw"})
        assert status == 503
        assert json.loads(body) == {"error": "Database unavailable"}
    finally:
        stop_test_server(httpd, thread)
