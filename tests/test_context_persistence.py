import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_group_context_persists_across_login(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie = extract_cookie(headers)
        headers1 = {'Cookie': cookie}
        # Create second group and switch context
        status, _, body = request('POST', port, '/api/groups', {'name': 'Band2'}, headers1)
        data = json.loads(body)
        group2_id = data['id']
        request('PUT', port, '/api/context', {'groupId': group2_id}, headers1)
        status, _, body = request('GET', port, '/api/context', headers=headers1)
        assert json.loads(body)['id'] == group2_id
        # Logout and login again
        request('POST', port, '/api/logout', headers=headers1)
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie2 = extract_cookie(headers)
        headers2 = {'Cookie': cookie2}
        status, _, body = request('GET', port, '/api/context', headers=headers2)
        assert json.loads(body)['id'] == group2_id
    finally:
        stop_test_server(httpd, thread)
