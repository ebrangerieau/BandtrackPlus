import json
from test_api import start_test_server, stop_test_server, request, extract_cookie
import bandtrack.api as server


def test_session_group_context():
    httpd, thread, port = start_test_server()
    try:
        request("POST", port, "/api/register", {"username": "jane", "password": "pw"})
        status, headers, _ = request("POST", port, "/api/login", {"username": "jane", "password": "pw"})
        assert status == 200
        cookie = extract_cookie(headers)
        token = cookie.split("=", 1)[1]
        with server.get_db_connection() as conn:
            cur = conn.cursor()
            server.execute_write(cur, "SELECT group_id FROM sessions WHERE token = %s", (token,))
            row = cur.fetchone()
            assert row is not None
            assert row["group_id"] == 1
        headers = {"Cookie": cookie}
        status, _, body = request("GET", port, "/api/context", headers=headers)
        assert status == 200
        assert json.loads(body)["id"] == 1
    finally:
        stop_test_server(httpd, thread)
