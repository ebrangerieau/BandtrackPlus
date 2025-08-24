# Simple Dockerfile for the BandTrack backend (Python version)

# Use a lightweight Python image
FROM python:3.11-slim

# Working directory in the container
WORKDIR /app

# Install Node.js to build the front-end bundle
RUN apt-get update && apt-get install -y nodejs npm && rm -rf /var/lib/apt/lists/*

# Copy front-end sources and build them
COPY package.json package-lock.json* ./
COPY node_modules ./node_modules
COPY vite.config.js postcss.config.js tailwind.config.js frontend.jsx ./
COPY src ./src
COPY public ./public
RUN npm run build:frontend

# Copy the Python server and migration scripts. The SQLite database will
# be created at runtime.
COPY server.py ./
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
