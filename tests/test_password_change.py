import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_password_change():
    httpd, thread, port = start_test_server()
    try:
        # Register and login
        status, headers, _ = request(
            "POST", port, "/api/register", {"username": "alice", "password": "old"}
        )
        assert status == 200
        status, headers, _ = request(
            "POST", port, "/api/login", {"username": "alice", "password": "old"}
        )
        assert status == 200
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}

        # Change password
        status, _, body = request(
            "PUT",
            port,
            "/api/password",
            {"oldPassword": "old", "newPassword": "new"},
            headers,
        )
        assert status == 200
        assert json.loads(body)["message"] == "Password updated"

        # Old password should fail
        status, _, _ = request(
            "POST", port, "/api/login", {"username": "alice", "password": "old"}
        )
        assert status == 401

        # New password should succeed
        status, headers, _ = request(
            "POST", port, "/api/login", {"username": "alice", "password": "new"}
        )
        assert status == 200

        # Invalid current password when updating
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}
        status, _, _ = request(
            "PUT",
            port,
            "/api/password",
            {"oldPassword": "wrong", "newPassword": "x"},
            headers,
        )
        assert status == 401
    finally:
        stop_test_server(httpd, thread)
