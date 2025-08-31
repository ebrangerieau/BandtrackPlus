import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import json
import server
from test_api import start_test_server, stop_test_server, request, extract_cookie


def test_default_settings_creation(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        # register and login
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie = extract_cookie(headers)
        headers = {'Cookie': cookie}

        # create new group
        status, _, body = request('POST', port, '/api/groups', {'name': 'Band2'}, headers)
        assert status == 201
        group_id = json.loads(body)['id']

        # settings should be created automatically
        status, _, body = request('GET', port, f'/api/{group_id}/settings', headers=headers)
        assert status == 200
        data = json.loads(body)
        assert data == {
            'groupName': 'Band2',
            'darkMode': True,
            'template': 'classic'
        }

        # delete settings row and ensure GET recreates defaults
        with server.get_db_connection() as conn:
            cur = conn.cursor()
            cur.execute('DELETE FROM settings WHERE group_id = ?', (group_id,))

        status, _, body = request('GET', port, f'/api/{group_id}/settings', headers=headers)
        assert status == 200
        data = json.loads(body)
        assert data['groupName'] == 'Band2'
        assert data['darkMode'] is True
    finally:
        stop_test_server(httpd, thread)


def test_settings_update(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie = extract_cookie(headers)
        headers = {'Cookie': cookie}

        status, _, body = request('POST', port, '/api/groups', {'name': 'Band2'}, headers)
        assert status == 201
        group_id = json.loads(body)['id']

        status, _, _ = request('PUT', port, f'/api/{group_id}/settings', {
            'groupName': 'Band2',
            'darkMode': True,
            'template': 'modern'
        }, headers)
        assert status == 200

        status, _, body = request('GET', port, f'/api/{group_id}/settings', headers=headers)
        assert status == 200
        data = json.loads(body)
        assert data['groupName'] == 'Band2'
        assert data['darkMode'] is True
        assert data['template'] == 'modern'

        status, _, body = request('GET', port, '/api/groups', headers=headers)
        assert status == 200
        groups = json.loads(body)
        assert any(g['id'] == group_id and g['name'] == 'Band2' for g in groups)
    finally:
        stop_test_server(httpd, thread)


def test_group_rename(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie = extract_cookie(headers)
        headers = {'Cookie': cookie}

        status, _, body = request('POST', port, '/api/groups', {'name': 'Band2'}, headers)
        assert status == 201
        group_id = json.loads(body)['id']

        status, _, _ = request('PUT', port, f'/api/groups/{group_id}', {
            'name': 'Renamed Band'
        }, headers)
        assert status == 200

        status, _, body = request('GET', port, '/api/groups', headers=headers)
        assert status == 200
        groups = json.loads(body)
        assert any(g['id'] == group_id and g['name'] == 'Renamed Band' for g in groups)
    finally:
        stop_test_server(httpd, thread)


def test_group_rename_unauthorized(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie_alice = extract_cookie(headers)
        headers_alice = {'Cookie': cookie_alice}

        status, _, body = request('POST', port, '/api/groups', {'name': 'Band2'}, headers_alice)
        assert status == 201
        data = json.loads(body)
        group_id = data['id']
        code = data['invitationCode']

        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'bob', 'password': 'pw'})
        cookie_bob = extract_cookie(headers)
        headers_bob = {'Cookie': cookie_bob}
        status, _, _ = request('POST', port, '/api/groups/join', {'code': code}, headers_bob)
        assert status == 201

        status, _, _ = request('PUT', port, f'/api/groups/{group_id}', {'name': 'Hacked'}, headers_bob)
        assert status == 403

        status, _, body = request('GET', port, '/api/groups', headers=headers_alice)
        assert status == 200
        groups = json.loads(body)
        assert any(g['id'] == group_id and g['name'] == 'Band2' for g in groups)
    finally:
        stop_test_server(httpd, thread)
