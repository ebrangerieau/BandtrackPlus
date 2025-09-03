"""Initialize PostgreSQL schema for BandtrackPlus."""
import server


def main():
    server.init_db()

if __name__ == "__main__":
    main()
