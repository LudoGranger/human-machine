# Human Machine backend (API + worker + MCP/QM provider) for an always-on host.
# Data (SQLite + GBrain PGLite brains + .env) lives on a volume at /data.
FROM oven/bun:1.4.2-debian

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# GBrain, pinned to the version the backend is tested against.
RUN bun install -g github:garrytan/gbrain#v0.59.0.0
ENV PATH="/root/.bun/bin:${PATH}"
RUN gbrain --version

WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY skills ./skills
COPY tsconfig.json ./

ENV HM_DATA_DIR=/data \
    HM_HOST=0.0.0.0 \
    HM_PORT=4747 \
    HM_LLM_PROVIDER=anthropic
EXPOSE 4747

# `init` is idempotent: creates /data/.env (mode 600), the brains and the catalog on first boot.
CMD ["sh", "-c", "bun run src/cli.ts init && exec bun run src/cli.ts serve"]
