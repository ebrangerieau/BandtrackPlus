import pytest
from test_api import start_test_server, stop_test_server, request, extract_cookie

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright


def test_dropdown_updates_after_group_rename():
    httpd, thread, port = start_test_server()
    try:
        # Register, login and create a group via API
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
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
            page.wait_for_selector('#group-select option')
            page.once('dialog', lambda dialog: dialog.accept('Renamed Band'))
            page.click('#rename-group-btn')
            page.wait_for_function("() => Array.from(document.querySelectorAll('#group-select option')).some(o => o.textContent === 'Renamed Band')")
            options_text = page.eval_on_selector_all('#group-select option', 'els => els.map(e => e.textContent)')
            assert 'Renamed Band' in options_text
            context.close()
            browser.close()
    finally:
        stop_test_server(httpd, thread)
