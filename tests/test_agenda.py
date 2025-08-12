import json

from test_api import start_test_server, stop_test_server, request, extract_cookie
import server


def test_agenda_endpoint(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        # Register and login to obtain session cookie
        status, headers, body = request(
            "POST", port, "/api/register", {"username": "alice", "password": "pw"}
        )
        user_id = json.loads(body)["id"]
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}

        # Insert rehearsal events directly into the database
        conn = server.get_db_connection()
        cur = conn.cursor()
        cur.execute(
            "INSERT INTO rehearsal_events (date, location, group_id, creator_id) VALUES (?, ?, ?, ?)",
            ("2024-01-10T20:00", "Studio", 1, user_id),
        )
        cur.execute(
            "INSERT INTO rehearsal_events (date, location, group_id, creator_id) VALUES (?, ?, ?, ?)",
            ("2024-02-05T20:00", "Studio B", 1, user_id),
        )
        conn.commit()
        conn.close()

        # Create performances via the API
        request(
            "POST",
            port,
            "/api/1/performances",
            {"name": "Gig1", "date": "2024-01-15T19:00", "location": "Club"},
            headers,
        )
        request(
            "POST",
            port,
            "/api/1/performances",
            {"name": "Gig2", "date": "2024-03-01T21:00", "location": "Hall"},
            headers,
        )

        # Fetch agenda with date range filters
        status, _, body = request(
            "GET",
            port,
            "/api/agenda?start=2024-01-01&end=2024-02-28",
            headers=headers,
        )
        assert status == 200
        items = json.loads(body)
        assert [i["type"] for i in items] == ["rehearsal", "performance", "rehearsal"]
        assert [i["date"] for i in items] == [
            "2024-01-10T20:00",
            "2024-01-15T19:00",
            "2024-02-05T20:00",
        ]

        # Start filter only
        status, _, body = request(
            "GET",
            port,
            "/api/agenda?start=2024-02-01",
            headers=headers,
        )
        assert status == 200
        items = json.loads(body)
        assert [i["date"] for i in items] == [
            "2024-02-05T20:00",
            "2024-03-01T21:00",
        ]
    finally:
        stop_test_server(httpd, thread)

