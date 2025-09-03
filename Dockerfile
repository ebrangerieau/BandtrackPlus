# Simple Dockerfile for the BandTrack backend (Python version)

# Use a lightweight Python image
FROM python:3.11-slim

# Working directory in the container
WORKDIR /app

# Copy dependency definitions and install them.  Installing dependencies
# before copying the rest of the application allows Docker to cache these
# layers more effectively and avoids reinstalling packages when only source
# code changes.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the Python server, migration scripts and front-end assets. The
# SQLite database will be created at runtime.
COPY main.py ./
COPY bandtrack ./bandtrack
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
# argparse defaults, so running ``python main.py`` is sufficient.
CMD ["python", "main.py"]
