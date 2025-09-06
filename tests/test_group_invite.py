import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_group_invite_new_user():
    httpd, thread, port = start_test_server()
    try:
        # Register admin user
        request('POST', port, '/api/register', {'username': 'admin@example.com', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'admin@example.com', 'password': 'pw'})
        cookie_admin = extract_cookie(headers)
        headers_admin = {'Cookie': cookie_admin}

        # Invite new user by email
        status, _, body = request('POST', port, '/api/groups/1/invite', {'email': 'newbie@example.com'}, headers_admin)
        assert status == 201
        data = json.loads(body)
        assert data['username'] == 'newbie@example.com'
        assert 'temporaryPassword' in data
        temp_pw = data['temporaryPassword']

        # New user can login with temporary password
        status, _, _ = request('POST', port, '/api/login', {'username': 'newbie@example.com', 'password': temp_pw})
        assert status == 200
    finally:
        stop_test_server(httpd, thread)


def test_group_invite_existing_user():
    httpd, thread, port = start_test_server()
    try:
        # Register admin user
        request('POST', port, '/api/register', {'username': 'admin@example.com', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'admin@example.com', 'password': 'pw'})
        cookie_admin = extract_cookie(headers)
        headers_admin = {'Cookie': cookie_admin}

        # Register another user and remove from group
        request('POST', port, '/api/register', {'username': 'bob@example.com', 'password': 'pw'})
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        members = json.loads(body)
        bob_member = next(m for m in members if m['username'] == 'bob@example.com')
        request('DELETE', port, '/api/groups/1/members', {'id': bob_member['id']}, headers_admin)

        # Invite existing user back by email
        status, _, body = request('POST', port, '/api/groups/1/invite', {'email': 'bob@example.com'}, headers_admin)
        assert status == 201
        data = json.loads(body)
        assert data['username'] == 'bob@example.com'
        assert 'temporaryPassword' not in data
    finally:
        stop_test_server(httpd, thread)
