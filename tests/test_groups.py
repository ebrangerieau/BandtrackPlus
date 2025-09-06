import json
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_group_flow():
    httpd, thread, port = start_test_server()
    try:
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_alice = extract_cookie(headers)
        headers_alice = {'Cookie': cookie_alice}
        status, _, body = request('POST', port, '/api/groups', {'name': 'Band'}, headers_alice)
        assert status == 201
        data = json.loads(body)
        code = data['invitationCode']
        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'bob', 'password': 'pw'})
        cookie_bob = extract_cookie(headers)
        headers_bob = {'Cookie': cookie_bob}
        status, _, _ = request('POST', port, '/api/groups/join', {'code': code, 'nickname': 'Bobby'}, headers_bob)
        assert status == 201
        status, _, body = request('POST', port, '/api/groups/renew-code', {}, headers_alice)
        assert status == 200
        new_code = json.loads(body)['invitationCode']
        assert new_code != code
    finally:
        stop_test_server(httpd, thread)
