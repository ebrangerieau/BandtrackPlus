import os, sys
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
import subprocess
import logging
from bandtrack.utils import scan_for_viruses
import pytest


def test_scan_for_viruses_timeout(monkeypatch, caplog):
    def fake_run(cmd, *args, **kwargs):
        # Simulate a long-running process by raising TimeoutExpired
        raise subprocess.TimeoutExpired(cmd=cmd, timeout=kwargs.get("timeout"))

    monkeypatch.setenv("AV_SCAN_CMD", "sleep 60")
    monkeypatch.setattr(subprocess, "run", fake_run)

    with caplog.at_level(logging.ERROR):
        result = scan_for_viruses(b"test")

    assert result is False
    assert "timed out" in caplog.text


@pytest.fixture(autouse=True)
def reset_db():
    """Override autouse fixture from conftest to avoid DB dependency."""
    pass
