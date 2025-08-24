from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_account_deletion(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        # Register initial admin user to set up default group
        request('POST', port, '/api/register', {'username': 'admin', 'password': 'pw'})

        # Register a second user who will delete their account
        status, headers, _ = request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})
        assert status == 200
        cookie = extract_cookie(headers)
        headers = {'Cookie': cookie}

        # Delete the account
        status, _, _ = request('DELETE', port, '/api/me', headers=headers)
        assert status == 200

        # Login should fail after deletion
        status, _, _ = request('POST', port, '/api/login', {'username': 'bob', 'password': 'pw'})
        assert status == 401
    finally:
        stop_test_server(httpd, thread)
