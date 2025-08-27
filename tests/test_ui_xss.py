import pytest
from test_api import start_test_server, stop_test_server, request, extract_cookie

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright


def test_script_title_not_executed(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / 'test.db')
    try:
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        cookie = extract_cookie(headers)
        headers = {'Cookie': cookie}
        request('POST', port, '/api/1/performances', {
            'name': '<script>window.hacked=1</script>',
            'date': '2099-01-01T20:00'
        }, headers)
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
            page.wait_for_selector('text=Prochaine prestation')
            hacked = page.evaluate('window.hacked')
            assert hacked is None
            content = page.inner_text('body')
            assert '<script>window.hacked=1</script>' in content
            context.close()
            browser.close()
    finally:
        stop_test_server(httpd, thread)
