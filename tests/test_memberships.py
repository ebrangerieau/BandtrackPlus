import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_memberships_crud():
    httpd, thread, port = start_test_server()
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


def test_memberships_add():
    httpd, thread, port = start_test_server()
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


def test_memberships_cross_group_delete():
    httpd, thread, port = start_test_server()
    try:
        # Register admin user and log in
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_admin = extract_cookie(headers)
        headers_admin = {'Cookie': cookie_admin}

        # Register bob and get his user id
        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        members = json.loads(body)
        bob_member = next(m for m in members if m['username'] == 'bob')
        bob_user_id = bob_member['userId']

        # Create second group and add bob to it
        status, _, body = request('POST', port, '/api/groups', {'name': 'Band2'}, headers=headers_admin)
        group2_id = json.loads(body)['id']
        request('POST', port, f'/api/groups/{group2_id}/members', {'userId': bob_user_id}, headers=headers_admin)

        # Get bob's membership id in group2
        status, _, body = request('GET', port, f'/api/groups/{group2_id}/members', headers=headers_admin)
        bob_member_group2 = next(m for m in json.loads(body) if m['username'] == 'bob')
        member2_id = bob_member_group2['id']

        # Attempt to delete group2 membership via group1 endpoint
        status, _, _ = request('DELETE', port, '/api/groups/1/members', {'id': member2_id}, headers=headers_admin)
        assert status == 404

        # Ensure bob's membership in group2 still exists
        status, _, body = request('GET', port, f'/api/groups/{group2_id}/members', headers=headers_admin)
        members = json.loads(body)
        assert any(m['id'] == member2_id for m in members)
    finally:
        stop_test_server(httpd, thread)


def test_memberships_delete_requires_identifier():
    httpd, thread, port = start_test_server()
    try:
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_admin = extract_cookie(headers)
        headers_admin = {'Cookie': cookie_admin}
        status, _, body = request('DELETE', port, '/api/groups/1/members', {}, headers_admin)
        assert status == 400
        assert json.loads(body)['error'] == 'Missing member identifier'
    finally:
        stop_test_server(httpd, thread)
