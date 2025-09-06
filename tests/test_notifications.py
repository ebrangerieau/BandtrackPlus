import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import threading
import http.client
import time
import json
import bandtrack.api as server


def start_test_server():
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
    if isinstance(body, (bytes, bytearray)):
        data = body
    elif body is not None:
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


def make_pdf_body(boundary, pdf_bytes, filename="sample.pdf"):
    return (
        f"--{boundary}\r\n"
        f"Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n"
        "Content-Type: application/pdf\r\n\r\n"
    ).encode() + pdf_bytes + f"\r\n--{boundary}--\r\n".encode()


def test_upload_notifications_and_opt_out():
    httpd, thread, port = start_test_server()
    try:
        # Register two users
        status, headers, _ = request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        assert status == 200
        cookie_alice = extract_cookie(headers)
        headers_alice = {"Cookie": cookie_alice}

        status, headers, _ = request("POST", port, "/api/register", {"username": "bob", "password": "pw"})
        assert status == 200
        cookie_bob = extract_cookie(headers)
        headers_bob = {"Cookie": cookie_bob}

        # Create rehearsal
        status, _, body = request("POST", port, "/api/rehearsals", {"title": "Song"}, headers_alice)
        assert status == 201
        rid = json.loads(body)["id"]

        pdf_bytes = b"%PDF-1.4\n%EOF"
        boundary = "testboundary"
        upload_body = make_pdf_body(boundary, pdf_bytes)
        upload_headers = {"Cookie": cookie_alice, "Content-Type": f"multipart/form-data; boundary={boundary}"}

        # Alice uploads a partition
        status, _, _ = request("POST", port, f"/api/rehearsals/{rid}/partitions", upload_body, upload_headers)
        assert status == 201

        # Bob should receive a notification
        status, _, body = request("GET", port, "/api/notifications", headers=headers_bob)
        assert status == 200
        notifs = json.loads(body)
        assert len(notifs) == 1 and "alice" in notifs[0]["message"].lower()

        # Alice should not receive a notification
        status, _, body = request("GET", port, "/api/notifications", headers=headers_alice)
        assert status == 200
        assert json.loads(body) == []

        # Bob opts out of upload notifications
        status, _, _ = request("PUT", port, "/api/user-settings", {"notifyUploads": False}, headers_bob)
        assert status == 200

        # Alice uploads again
        status, _, _ = request("POST", port, f"/api/rehearsals/{rid}/partitions", upload_body, upload_headers)
        assert status == 201

        # Bob's notifications count remains the same
        status, _, body = request("GET", port, "/api/notifications", headers=headers_bob)
        assert status == 200
        notifs = json.loads(body)
        assert len(notifs) == 1
    finally:
        stop_test_server(httpd, thread)
