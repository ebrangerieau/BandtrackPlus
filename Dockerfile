# Simple Dockerfile for the BandTrack backend (Python version)

# Use a lightweight Python image
FROM python:3.11-slim

# Working directory in the container
WORKDIR /app

# Copy the Python server and the front‑end into the container.  We do not
# copy the Node‑specific db.js or any Node modules because this image runs
# the Python backend only.  The SQLite database will be created at runtime.
COPY server.py ./
COPY public ./public
COPY scripts ./scripts

# Create a volume for persistent database storage
VOLUME ["/data"]

# Set environment variables to configure host/port (optional)
ENV HOST=0.0.0.0
ENV PORT=8080

# Expose the port the app listens on
EXPOSE ${PORT}

# Entrypoint to run the Python server.  We omit explicit host/port arguments
# here because environment variables are not expanded when using the JSON
# form of CMD.  The server reads HOST and PORT from its environment via
# argparse defaults, so running ``python server.py`` is sufficient.
CMD ["python", "server.py"]
