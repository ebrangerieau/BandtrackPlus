from test_api import start_test_server, stop_test_server, request, extract_cookie
from playwright.sync_api import sync_playwright


def test_delete_account_button_visible(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        # register and login to obtain session cookie
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        assert status == 200
        cookie = extract_cookie(headers)
        headers = {'Cookie': cookie}
        status, _, _ = request('POST', port, '/api/groups', {'name': 'Band'}, headers)
        assert status == 201
        session_value = cookie.split('=', 1)[1]
        with sync_playwright() as p:
            browser = p.chromium.launch()
            context = browser.new_context()
            context.add_cookies([
                {
                    'name': 'session_id',
                    'value': session_value,
                    'domain': '127.0.0.1',
                    'path': '/',
                }
            ])
            page = context.new_page()
            page.goto(f'http://127.0.0.1:{port}/')
            page.click('#hamburger')
            page.click('#menu-settings')
            page.wait_for_load_state('networkidle')
            page.wait_for_selector('#delete-account-btn')
            assert page.is_visible('#delete-account-btn')
            context.close()
            browser.close()
    finally:
        stop_test_server(httpd, thread)
