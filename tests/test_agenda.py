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
        with server.get_db_connection() as conn:
            cur = conn.cursor()
            server.execute_write(
                cur,
                "INSERT INTO rehearsal_events (date, location, group_id, creator_id) VALUES (?, ?, ?, ?)",
                ("2024-01-10T20:00", "Studio", 1, user_id),
            )
            server.execute_write(
                cur,
                "INSERT INTO rehearsal_events (date, location, group_id, creator_id) VALUES (?, ?, ?, ?)",
                ("2024-02-05T20:00", "Studio B", 1, user_id),
            )

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


def test_agenda_crud(tmp_path):
    httpd, thread, port = start_test_server(tmp_path / "test.db")
    try:
        request("POST", port, "/api/register", {"username": "bob", "password": "pw"})
        status, headers, _ = request(
            "POST", port, "/api/login", {"username": "bob", "password": "pw"}
        )
        cookie = extract_cookie(headers)
        headers = {"Cookie": cookie}

        # Unauthorized access
        status, _, _ = request("GET", port, "/api/agenda")
        assert status == 403
        status, _, _ = request(
            "POST",
            port,
            "/api/agenda",
            {"type": "rehearsal", "date": "2024-04-01T20:00"},
        )
        assert status == 403

        # Create rehearsal event
        status, _, body = request(
            "POST",
            port,
            "/api/agenda",
            {"type": "rehearsal", "date": "2024-04-01T20:00", "location": "Room"},
            headers,
        )
        assert status == 201
        reh_id = json.loads(body)["id"]

        # Unauthorized update
        status, _, _ = request(
            "PUT",
            port,
            f"/api/agenda/{reh_id}",
            {"type": "rehearsal", "date": "2024-04-02T20:00"},
        )
        assert status == 403

        # Update rehearsal event
        status, _, body = request(
            "PUT",
            port,
            f"/api/agenda/{reh_id}",
            {
                "type": "rehearsal",
                "date": "2024-04-02T20:00",
                "location": "Studio B",
            },
            headers,
        )
        assert status == 200
        updated = json.loads(body)
        assert updated["date"] == "2024-04-02T20:00"
        assert updated["location"] == "Studio B"

        status, _, body = request("GET", port, "/api/agenda", headers=headers)
        items = json.loads(body)
        assert any(i["id"] == reh_id and i["location"] == "Studio B" for i in items)

        # Unauthorized delete
        status, _, _ = request(
            "DELETE", port, f"/api/agenda/{reh_id}", {"type": "rehearsal"}
        )
        assert status == 403

        # Delete rehearsal event
        status, _, _ = request(
            "DELETE",
            port,
            f"/api/agenda/{reh_id}",
            {"type": "rehearsal"},
            headers,
        )
        assert status == 200
        status, _, body = request("GET", port, "/api/agenda", headers=headers)
        assert all(i["id"] != reh_id for i in json.loads(body))

        # Create performance event
        status, _, body = request(
            "POST",
            port,
            "/api/agenda",
            {
                "type": "performance",
                "name": "Gig",
                "date": "2024-05-01T21:00",
                "location": "Club",
            },
            headers,
        )
        assert status == 201
        perf_id = json.loads(body)["id"]

        # Unauthorized update
        status, _, _ = request(
            "PUT",
            port,
            f"/api/agenda/{perf_id}",
            {
                "type": "performance",
                "name": "Gig2",
                "date": "2024-05-02T21:30",
                "location": "Hall",
            },
        )
        assert status == 403

        # Update performance event
        status, _, body = request(
            "PUT",
            port,
            f"/api/agenda/{perf_id}",
            {
                "type": "performance",
                "name": "Gig2",
                "date": "2024-05-02T21:30",
                "location": "Hall",
            },
            headers,
        )
        assert status == 200
        updated = json.loads(body)
        assert updated["title"] == "Gig2"
        assert updated["date"] == "2024-05-02T21:30"

        status, _, body = request("GET", port, "/api/agenda", headers=headers)
        items = json.loads(body)
        assert any(i["id"] == perf_id and i["title"] == "Gig2" for i in items)

        # Unauthorized delete
        status, _, _ = request(
            "DELETE", port, f"/api/agenda/{perf_id}", {"type": "performance"}
        )
        assert status == 403

        # Delete performance event
        status, _, _ = request(
            "DELETE",
            port,
            f"/api/agenda/{perf_id}",
            {"type": "performance"},
            headers,
        )
        assert status == 200
        status, _, body = request("GET", port, "/api/agenda", headers=headers)
        assert all(i["id"] != perf_id for i in json.loads(body))
    finally:
        stop_test_server(httpd, thread)


