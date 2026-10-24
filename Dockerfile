FROM node:24-bookworm-slim AS frontend
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM ghcr.io/astral-sh/uv:python3.14-bookworm-slim
WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    PYTHONUNBUFFERED=1 \
    SITETWIN_STORAGE=/data
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY agent/ agent/
COPY benchmark/ benchmark/
COPY capture/ capture/
COPY core/ core/
COPY server/ server/
COPY starter_agent/ starter_agent/
COPY data/ data/
COPY --from=frontend /web/dist/ web/dist/
RUN uv sync --frozen --no-dev
EXPOSE 8000
CMD ["sh", "-c", "exec .venv/bin/uvicorn server.production:app --host 0.0.0.0 --port ${PORT:-8000}"]
