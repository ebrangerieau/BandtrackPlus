import argparse
import os

from bandtrack.api import run_server


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the BandTrack server")
    parser.add_argument("--host", default=os.environ.get("HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 8080)))
    args = parser.parse_args()
    run_server(args.host, args.port)


if __name__ == "__main__":
    main()
