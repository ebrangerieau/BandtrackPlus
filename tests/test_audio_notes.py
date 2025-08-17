import os
import sys
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


def test_multiple_audio_notes_with_titles(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        request("POST", port, "/api/register", {"username": "alice", "password": "pw"})
        status, headers, _ = request("POST", port, "/api/login", {"username": "alice", "password": "pw"})
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}

        status, _, body = request("POST", port, "/api/1/rehearsals", {"title": "Song"}, headers)
        assert status == 201
        rid = json.loads(body)["id"]

        audio1 = "data:audio/wav;base64,AAA"
        audio2 = "data:audio/wav;base64,BBB"
        status, _, _ = request(
            "PUT", port, f"/api/1/rehearsals/{rid}", {"audio": audio1, "audioTitle": "Intro"}, headers
        )
        assert status == 200
        status, _, _ = request(
            "PUT", port, f"/api/1/rehearsals/{rid}", {"audio": audio2, "audioTitle": "Chorus"}, headers
        )
        assert status == 200

        status, _, body = request("GET", port, "/api/1/rehearsals", headers=headers)
        assert status == 200
        songs = json.loads(body)
        notes = songs[0]["audioNotes"]["alice"]
        assert len(notes) == 2
        assert [n["title"] for n in notes] == ["Intro", "Chorus"]
    finally:
        stop_test_server(httpd, thread)
