import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_account_deletion():
    httpd, thread, port = start_test_server()
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


def test_cannot_delete_account_while_owning_group():
    httpd, thread, port = start_test_server()
    try:
        # Register initial admin user to set up default group
        request('POST', port, '/api/register', {'username': 'admin', 'password': 'pw'})

        # Register a user who will own a group
        status, headers, _ = request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        assert status == 200
        cookie = extract_cookie(headers)
        headers = {'Cookie': cookie}

        # Create a group
        status, _, _ = request('POST', port, '/api/groups', {'name': 'Band'}, headers)
        assert status == 201

        # Attempt to delete the account
        status, _, body = request('DELETE', port, '/api/me', headers=headers)
        assert status == 400
        data = json.loads(body)
        assert data['error'] == 'Cannot delete account while owning a group'
    finally:
        stop_test_server(httpd, thread)
