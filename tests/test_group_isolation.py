import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_group_isolation_and_context(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        # Alice registers and logs in (admin of default group 1)
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_alice = extract_cookie(headers)
        headers_alice = {'Cookie': cookie_alice}

        # Create resources in default group 1
        request('POST', port, '/api/1/suggestions', {'title': 'SongA'}, headers_alice)
        request('POST', port, '/api/1/rehearsals', {'title': 'RehA'}, headers_alice)
        request(
            'POST',
            port,
            '/api/1/performances',
            {'name': 'PerfA', 'date': '2024-01-01'},
            headers_alice,
        )

        # Create second group and resources within it
        status, _, body = request('POST', port, '/api/groups', {'name': 'Band2'}, headers_alice)
        data = json.loads(body)
        group2_id = data['id']
        code = data['invitationCode']

        status, _, body = request(
            'POST',
            port,
            f'/api/{group2_id}/suggestions',
            {'title': 'SongB'},
            headers_alice,
        )
        sug2_id = json.loads(body)['id']
        request('POST', port, f'/api/{group2_id}/rehearsals', {'title': 'RehB'}, headers_alice)
        request(
            'POST',
            port,
            f'/api/{group2_id}/performances',
            {'name': 'PerfB', 'date': '2024-02-02'},
            headers_alice,
        )

        # Verify isolation for Alice across groups
        status, _, body = request('GET', port, '/api/1/suggestions', headers=headers_alice)
        assert [s['title'] for s in json.loads(body)] == ['SongA']
        status, _, body = request('GET', port, f'/api/{group2_id}/suggestions', headers=headers_alice)
        assert [s['title'] for s in json.loads(body)] == ['SongB']

        status, _, body = request('GET', port, '/api/1/rehearsals', headers=headers_alice)
        assert [r['title'] for r in json.loads(body)] == ['RehA']
        status, _, body = request('GET', port, f'/api/{group2_id}/rehearsals', headers=headers_alice)
        assert [r['title'] for r in json.loads(body)] == ['RehB']

        status, _, body = request('GET', port, '/api/1/performances', headers=headers_alice)
        assert [p['name'] for p in json.loads(body)] == ['PerfA']
        status, _, body = request('GET', port, f'/api/{group2_id}/performances', headers=headers_alice)
        assert [p['name'] for p in json.loads(body)] == ['PerfB']

        # Bob registers (only member of default group 1)
        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'bob', 'password': 'pw'})
        cookie_bob = extract_cookie(headers)
        headers_bob = {'Cookie': cookie_bob}

        # Bob cannot access group2 before joining
        status, _, _ = request('GET', port, f'/api/{group2_id}/suggestions', headers=headers_bob)
        assert status == 403
        status, _, _ = request('GET', port, f'/api/{group2_id}/rehearsals', headers=headers_bob)
        assert status == 403
        status, _, _ = request('GET', port, f'/api/{group2_id}/performances', headers=headers_bob)
        assert status == 403

        # Bob joins group2 via invitation code
        status, _, _ = request(
            'POST',
            port,
            '/api/groups/join',
            {'code': code, 'nickname': 'Bobby'},
            headers_bob,
        )
        assert status == 201

        # Switch Bob's context to group2
        status, _, _ = request('PUT', port, '/api/context', {'groupId': group2_id}, headers=headers_bob)
        assert status == 200
        status, _, body = request('GET', port, '/api/context', headers=headers_bob)
        assert json.loads(body)['id'] == group2_id

        # Bob sees only group2 items when using context
        status, _, body = request('GET', port, '/api/suggestions', headers=headers_bob)
        assert [s['title'] for s in json.loads(body)] == ['SongB']
        status, _, body = request('GET', port, '/api/rehearsals', headers=headers_bob)
        assert [r['title'] for r in json.loads(body)] == ['RehB']
        status, _, body = request('GET', port, '/api/performances', headers=headers_bob)
        assert [p['name'] for p in json.loads(body)] == ['PerfB']

        # Role-based access: Bob cannot edit suggestion yet
        status, _, _ = request(
            'PUT',
            port,
            f'/api/suggestions/{sug2_id}',
            {'title': 'SongB2'},
            headers=headers_bob,
        )
        assert status == 403

        # Promote Bob to moderator and retry
        status, _, body = request('GET', port, '/api/me', headers=headers_bob)
        bob_id = json.loads(body)['id']
        request('PUT', port, f'/api/users/{bob_id}', {'role': 'moderator'}, headers=headers_alice)
        status, _, _ = request(
            'PUT',
            port,
            f'/api/suggestions/{sug2_id}',
            {'title': 'SongB2'},
            headers=headers_bob,
        )
        assert status == 200
    finally:
        stop_test_server(httpd, thread)
