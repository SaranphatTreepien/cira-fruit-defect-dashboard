# Python workers image for docker compose services "writer", "watcher" and "bot".
# Build context is the project root (see docker-compose.yml).
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONIOENCODING=utf-8
RUN pip install --no-cache-dir "paho-mqtt>=2,<3" "psycopg2-binary>=2.9,<3"
COPY scripts ./scripts
