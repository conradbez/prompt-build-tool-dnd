# Single-service image: build the frontend, then serve it AND the API from the
# FastAPI server. Railway prefers this Dockerfile over static detection, so the
# deployed URL hosts the app at `/` and answers `POST /run` on the same origin.

# ---- Stage 1: build the React frontend ----
FROM node:20-slim AS web
WORKDIR /web
RUN corepack enable
COPY . .
RUN yarn install --immutable && yarn build

# ---- Stage 2: Python server (serves /run + the built dist/) ----
FROM python:3.12-slim
WORKDIR /app
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /usr/local/bin/uv
COPY server/pyproject.toml server/uv.lock ./server/
RUN cd server && uv sync --frozen --no-dev --no-install-project
COPY server ./server
COPY --from=web /web/dist ./dist
WORKDIR /app/server
ENV PATH="/app/server/.venv/bin:$PATH"
# Railway provides $PORT; default to 8000 for local `docker run`.
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
