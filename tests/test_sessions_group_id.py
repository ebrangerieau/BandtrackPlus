import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import json
import threading
import http.client
import time
import bandtrack.api as server


def start_test_server(tmp_db_path=None):
    server.init_db()
    httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.BandTrackHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
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


def test_session_contains_group_id(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        request("POST", port, "/api/register", {"username": "sam", "password": "pw"})
        status, headers, _ = request("POST", port, "/api/login", {"username": "sam", "password": "pw"})
        assert status == 200
        cookie = extract_cookie(headers)
        token = cookie.split("=", 1)[1]
        with server.get_db_connection() as conn:
            cur = conn.cursor()
            server.execute_write(cur, 'SELECT group_id FROM sessions WHERE token = ?', (token,))
            row = cur.fetchone()
            assert row is not None
            assert row['group_id'] == 1
        headers = {"Cookie": cookie}
        status, _, _ = request("GET", port, "/api/me", headers=headers)
        assert status == 200
    finally:
        stop_test_server(httpd, thread)
