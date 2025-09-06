import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import threading
import http.client
import time
import json
import logging
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


def test_partition_upload_list_download_and_delete():
    httpd, thread, port = start_test_server()
    try:
        status, headers, _ = request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        assert status == 200
        cookie_alice = extract_cookie(headers)
        headers_alice = {"Cookie": cookie_alice}

        status, _, body = request("POST", port, "/api/rehearsals", {"title": "Song"}, headers_alice)
        assert status == 201
        rid = json.loads(body)["id"]

        pdf_bytes = b"%PDF-1.4\n%EOF"
        boundary = "testboundary"

        upload_body = make_pdf_body(boundary, pdf_bytes)
        upload_headers = {"Cookie": cookie_alice, "Content-Type": f"multipart/form-data; boundary={boundary}"}
        status, _, body = request("POST", port, f"/api/rehearsals/{rid}/partitions", upload_body, upload_headers)
        assert status == 201
        part_info = json.loads(body)
        pid1 = part_info["id"]
        download_url = part_info["downloadUrl"]

        status, _, body = request("GET", port, f"/api/rehearsals/{rid}/partitions", headers=headers_alice)
        assert status == 200
        parts = json.loads(body)
        assert len(parts) == 1 and parts[0]["id"] == pid1

        status, _, body = request("GET", port, download_url, headers=headers_alice)
        assert status == 200 and body == pdf_bytes

        status, headers, _ = request("POST", port, "/api/register", {"username": "bob", "password": "pw"})
        assert status == 200
        cookie_bob = extract_cookie(headers)
        headers_bob = {"Cookie": cookie_bob}

        status, _, _ = request("DELETE", port, f"/api/rehearsals/{rid}/partitions/{pid1}", headers=headers_bob)
        assert status == 403

        status, _, _ = request("DELETE", port, f"/api/rehearsals/{rid}/partitions/{pid1}", headers=headers_alice)
        assert status == 200

        upload_body_bob = make_pdf_body(boundary, pdf_bytes, "bob.pdf")
        upload_headers_bob = {"Cookie": cookie_bob, "Content-Type": f"multipart/form-data; boundary={boundary}"}
        status, _, body = request("POST", port, f"/api/rehearsals/{rid}/partitions", upload_body_bob, upload_headers_bob)
        assert status == 201
        pid2 = json.loads(body)["id"]

        status, _, _ = request("DELETE", port, f"/api/rehearsals/{rid}/partitions/{pid2}", headers=headers_bob)
        assert status == 200

        status, _, body = request("POST", port, f"/api/rehearsals/{rid}/partitions", upload_body_bob, upload_headers_bob)
        assert status == 201
        pid3 = json.loads(body)["id"]

        status, _, _ = request("DELETE", port, f"/api/rehearsals/{rid}/partitions/{pid3}", headers=headers_alice)
        assert status == 200
    finally:
        stop_test_server(httpd, thread)


def test_partition_delete_missing_file_logs_warning(caplog):
    httpd, thread, port = start_test_server()
    try:
        status, headers, _ = request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        assert status == 200
        cookie = extract_cookie(headers)
        headers_alice = {"Cookie": cookie}

        status, _, body = request("POST", port, "/api/rehearsals", {"title": "Song"}, headers_alice)
        assert status == 201
        rid = json.loads(body)["id"]

        pdf_bytes = b"%PDF-1.4\n%EOF"
        boundary = "testboundary"
        upload_body = make_pdf_body(boundary, pdf_bytes)
        upload_headers = {"Cookie": cookie, "Content-Type": f"multipart/form-data; boundary={boundary}"}
        status, _, body = request("POST", port, f"/api/rehearsals/{rid}/partitions", upload_body, upload_headers)
        assert status == 201
        pid = json.loads(body)["id"]

        file_path = os.path.join(server.UPLOADS_ROOT, str(rid), f"{pid}.pdf")
        assert os.path.exists(file_path)
        os.remove(file_path)

        with caplog.at_level(logging.WARNING):
            status, _, _ = request(
                "DELETE", port, f"/api/rehearsals/{rid}/partitions/{pid}", headers=headers_alice
            )
        assert status == 200
        assert "Failed to remove partition file" in caplog.text
        assert any(rec.exc_info for rec in caplog.records)
    finally:
        stop_test_server(httpd, thread)
