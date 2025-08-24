import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_group_members_crud(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        # Register admin user
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_admin = extract_cookie(headers)
        headers_admin = {'Cookie': cookie_admin}

        # Register second user
        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})

        # List members
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        assert status == 200
        members = json.loads(body)
        assert any(m['username'] == 'alice' for m in members)
        bob_member = next(m for m in members if m['username'] == 'bob')
        member_id = bob_member['id']
        user_id = bob_member['userId']

        # Update bob's membership
        status, _, _ = request('PUT', port, '/api/groups/1/members', {
            'id': member_id,
            'role': 'moderator',
            'nickname': 'Bobby',
            'active': True,
        }, headers_admin)
        assert status == 200

        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        members = json.loads(body)
        bob_member = next(m for m in members if m['username'] == 'bob')
        assert bob_member['role'] == 'moderator'
        assert bob_member['nickname'] == 'Bobby'

        # Delete bob's membership via userId
        status, _, _ = request('DELETE', port, '/api/groups/1/members', {'userId': user_id}, headers_admin)
        assert status == 200
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        members = json.loads(body)
        assert all(m['username'] != 'bob' for m in members)
    finally:
        stop_test_server(httpd, thread)


def test_group_members_add(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        # Register admin user
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_admin = extract_cookie(headers)
        headers_admin = {'Cookie': cookie_admin}

        # Register another user
        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})

        # Remove bob from group 1 to simulate non-member
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        members = json.loads(body)
        bob_member = next(m for m in members if m['username'] == 'bob')
        status, _, _ = request('DELETE', port, '/api/groups/1/members', {'id': bob_member['id']}, headers=headers_admin)
        assert status == 200

        # Add bob back via POST
        status, _, body = request(
            'POST',
            port,
            '/api/groups/1/members',
            {'userId': bob_member['userId']},
            headers=headers_admin,
        )
        assert status == 201

        # Verify bob is listed again
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        assert status == 200
        members = json.loads(body)
        assert any(m['username'] == 'bob' for m in members)
    finally:
        stop_test_server(httpd, thread)
