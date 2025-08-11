import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import json
import threading
import http.client
import time
import server


def start_test_server(tmp_db_path):
    server.DB_FILENAME = str(tmp_db_path)
    server.init_db()
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.BandTrackHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    # Give server time to start
    time.sleep(0.1)
    return httpd, thread, port


def stop_test_server(httpd, thread):
    httpd.shutdown()
    thread.join()


def request(method, port, path, body=None, headers=None):
    conn = http.client.HTTPConnection("127.0.0.1", port)
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers = {"Content-Type": "application/json", **(headers or {})}
    conn.request(method, path, data, headers or {})
    res = conn.getresponse()
    res_body = res.read()
    status = res.status
    resp_headers = dict(res.getheaders())
    conn.close()
    return status, resp_headers, res_body


def extract_cookie(headers):
    cookie = headers.get("Set-Cookie")
    if not cookie:
        return None
    return cookie.split(";", 1)[0]


def test_register_and_login(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        status, headers, _ = request(
            "POST",
            port,
            "/api/register",
            {"username": "alice", "password": "secret"},
        )
        assert status == 200
        status, headers, _ = request(
            "POST",
            port,
            "/api/login",
            {"username": "alice", "password": "secret"},
        )
        assert status == 200
        cookie = extract_cookie(headers)
        assert cookie and cookie.startswith("session_id=")
    finally:
        stop_test_server(httpd, thread)


def test_login_without_group(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        request(
            "POST",
            port,
            "/api/register",
            {"username": "dave", "password": "pw"},
        )
        # Remove group memberships for this user
        conn = server.get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "DELETE FROM memberships WHERE user_id = (SELECT id FROM users WHERE username = ?)",
            ("dave",),
        )
        conn.commit()
        conn.close()
        status, headers, body = request(
            "POST", port, "/api/login", {"username": "dave", "password": "pw"}
        )
        assert status == 200
        data = json.loads(body)
        assert data["user"]["needsGroup"] is True
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}
        status, _, body = request("GET", port, "/api/me", headers=headers)
        assert status == 200
        assert json.loads(body)["needsGroup"] is True
    finally:
        stop_test_server(httpd, thread)


def test_suggestions_crud(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        request("POST", port, "/api/register", {"username": "bob", "password": "pw"})
        status, headers, _ = request("POST", port, "/api/login", {"username": "bob", "password": "pw"})
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}

        status, _, body = request("POST", port, "/api/1/suggestions", {"title": "Song"}, headers)
        assert status == 201
        sug_id = json.loads(body)["id"]

        status, _, body = request("GET", port, "/api/1/suggestions", headers=headers)
        assert status == 200
        suggestions = json.loads(body)
        assert len(suggestions) == 1

        status, _, _ = request("PUT", port, f"/api/1/suggestions/{sug_id}", {"title": "Song2"}, headers)
        assert status == 200
        status, _, body = request("GET", port, "/api/1/suggestions", headers=headers)
        assert json.loads(body)[0]["title"] == "Song2"

        status, _, _ = request("DELETE", port, f"/api/1/suggestions/{sug_id}", headers=headers)
        assert status == 200
        status, _, body = request("GET", port, "/api/1/suggestions", headers=headers)
        assert json.loads(body) == []
    finally:
        stop_test_server(httpd, thread)


def test_rehearsals_crud(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        request("POST", port, "/api/register", {"username": "carol", "password": "pw"})
        status, headers, _ = request("POST", port, "/api/login", {"username": "carol", "password": "pw"})
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}

        status, _, body = request("POST", port, "/api/1/rehearsals", {"title": "R1"}, headers)
        assert status == 201
        reh_id = json.loads(body)["id"]

        status, _, _ = request("PUT", port, f"/api/1/rehearsals/{reh_id}", {"level": 5, "note": "ok"}, headers)
        assert status == 200

        status, _, body = request("PUT", port, f"/api/1/rehearsals/{reh_id}/mastered", headers=headers)
        assert status == 200
        assert json.loads(body)["mastered"] is True

        status, _, _ = request("DELETE", port, f"/api/1/rehearsals/{reh_id}", headers=headers)
        assert status == 200
        status, _, body = request("GET", port, "/api/1/rehearsals", headers=headers)
        assert json.loads(body) == []
    finally:
        stop_test_server(httpd, thread)


def test_roles_and_permissions(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        # Register and login admin (first user)
        request("POST", port, "/api/register", {"username": "admin", "password": "pw"})
        status, headers, body = request("POST", port, "/api/login", {"username": "admin", "password": "pw"})
        cookie_admin = extract_cookie(headers)
        headers_admin = {"Cookie": cookie_admin}
        status, _, body = request("GET", port, "/api/me", headers=headers_admin)
        assert json.loads(body)["role"] == "admin"

        # Admin creates a suggestion
        status, _, body = request("POST", port, "/api/1/suggestions", {"title": "Song"}, headers_admin)
        sug_id = json.loads(body)["id"]

        # Register and login second user (bob)
        request("POST", port, "/api/register", {"username": "bob", "password": "pw"})
        status, headers, _ = request("POST", port, "/api/login", {"username": "bob", "password": "pw"})
        cookie_bob = extract_cookie(headers)
        headers_bob = {"Cookie": cookie_bob}
        status, _, body = request("GET", port, "/api/me", headers=headers_bob)
        bob_id = json.loads(body)["id"]
        assert json.loads(body)["role"] == "user"

        # Register third user (charlie)
        request("POST", port, "/api/register", {"username": "charlie", "password": "pw"})
        status, headers, _ = request("POST", port, "/api/login", {"username": "charlie", "password": "pw"})
        cookie_charlie = extract_cookie(headers)
        headers_charlie = {"Cookie": cookie_charlie}

        # Promote bob to moderator
        request("PUT", port, f"/api/users/{bob_id}", {"role": "moderator"}, headers_admin)

        # Charlie (user) cannot edit admin's suggestion
        status, _, _ = request("PUT", port, f"/api/1/suggestions/{sug_id}", {"title": "X"}, headers_charlie)
        assert status == 403

        # Bob (moderator) can edit admin's suggestion
        status, _, _ = request("PUT", port, f"/api/1/suggestions/{sug_id}", {"title": "Y"}, headers_bob)
        assert status == 200
    finally:
        stop_test_server(httpd, thread)
