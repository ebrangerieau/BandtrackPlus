import pytest
from test_api import start_test_server, stop_test_server, request, extract_cookie

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright


def test_ui_account_deletion():
    httpd, thread, port = start_test_server()
    try:
        # Register and login to create session
        request('POST', port, '/api/register', {'username': 'alice', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        assert status == 200
        cookie = extract_cookie(headers)
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
            def handle_dialog(dialog):
                assert dialog.type == 'confirm'
                assert dialog.message == 'Êtes-vous sûr de vouloir supprimer votre compte ?'
                dialog.accept()

            page.once('dialog', handle_dialog)
            page.click('#delete-account-btn')
            page.wait_for_selector('text=Se connecter')
            context.close()
            browser.close()
        status, _, _ = request('POST', port, '/api/login', {'username': 'alice', 'password': 'pw'})
        assert status == 401
    finally:
        stop_test_server(httpd, thread)


def test_ui_account_deletion_from_group_setup():
    httpd, thread, port = start_test_server()
    try:
        request('POST', port, '/api/register', {'username': 'bob', 'password': 'pw'})
        status, headers, _ = request('POST', port, '/api/login', {'username': 'bob', 'password': 'pw'})
        assert status == 200
        cookie = extract_cookie(headers)
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
            page.wait_for_selector('#delete-account-btn-group-setup')
            def handle_dialog(dialog):
                assert dialog.type == 'confirm'
                assert dialog.message == 'Êtes-vous sûr de vouloir supprimer votre compte ?'
                dialog.accept()

            page.once('dialog', handle_dialog)
            page.click('#delete-account-btn-group-setup')
            page.wait_for_selector('text=Se connecter')
            context.close()
            browser.close()
        status, _, _ = request('POST', port, '/api/login', {'username': 'bob', 'password': 'pw'})
        assert status == 401
    finally:
        stop_test_server(httpd, thread)
