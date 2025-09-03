import os
import sys

sys.path.append(os.path.dirname(os.path.dirname(__file__)))
from bandtrack.auth import hash_password, verify_password


def test_verify_password_valid_and_invalid():
    salt, expected_hash = hash_password("correcthorsebatterystaple")
    assert verify_password("correcthorsebatterystaple", salt, expected_hash)
    assert not verify_password("tr0ub4dor&3", salt, expected_hash)
