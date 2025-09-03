import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import json
import bandtrack.api as server
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_group_member_can_leave_and_context_cleared(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        # Register admin user and log in
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, body = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_admin = extract_cookie(headers)
        admin_user_id = json.loads(body)['user']['id']
        headers_admin = {'Cookie': cookie_admin}

        # Register regular member and log in
        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})
        status, headers, body = request('POST', port, '/api/login', {'username': 'bob', 'password': 'pw'})
        cookie_bob = extract_cookie(headers)
        bob_user_id = json.loads(body)['user']['id']
        headers_bob = {'Cookie': cookie_bob}

        # Bob cannot delete Alice's membership
        status, _, _ = request('DELETE', port, '/api/groups/1/members', {'userId': admin_user_id}, headers_bob)
        assert status == 403
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        members = json.loads(body)
        assert any(m['userId'] == admin_user_id for m in members)

        # Bob leaves the group himself
        status, _, _ = request('DELETE', port, '/api/groups/1/members', {'userId': bob_user_id}, headers_bob)
        assert status == 200

        # Admin check confirms Bob is removed
        status, _, body = request('GET', port, '/api/groups/1/members', headers=headers_admin)
        members = json.loads(body)
        assert all(m['userId'] != bob_user_id for m in members)

        # Bob's session context is cleared
        status, _, body = request('GET', port, '/api/me', headers=headers_bob)
        assert status == 200
        assert json.loads(body)['needsGroup'] is True
        status, _, _ = request('GET', port, '/api/groups/1/members', headers=headers_bob)
        assert status == 403

        # last_group_id in database is cleared
        with server.get_db_connection() as conn:
            cur = conn.cursor()
            server.execute_write(cur, 'SELECT last_group_id FROM users WHERE id = ?', (bob_user_id,))
            row = cur.fetchone()
        assert row['last_group_id'] is None
    finally:
        stop_test_server(httpd, thread)
