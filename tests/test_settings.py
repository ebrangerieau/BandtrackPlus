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
            'darkMode': False,
            'template': 'classic',
            'nextRehearsalDate': '',
            'nextRehearsalLocation': ''
        }

        # delete settings row and ensure GET recreates defaults
        conn = server.get_db_connection()
        cur = conn.cursor()
        cur.execute('DELETE FROM settings WHERE group_id = ?', (group_id,))
        conn.commit()
        conn.close()

        status, _, body = request('GET', port, f'/api/{group_id}/settings', headers=headers)
        assert status == 200
        data = json.loads(body)
        assert data['groupName'] == 'Band2'
        assert data['darkMode'] is False
    finally:
        stop_test_server(httpd, thread)
