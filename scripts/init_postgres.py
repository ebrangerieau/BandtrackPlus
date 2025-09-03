"""Initialize PostgreSQL schema for BandtrackPlus."""
from bandtrack.db import init_db


def main():
    init_db()

if __name__ == "__main__":
    main()
