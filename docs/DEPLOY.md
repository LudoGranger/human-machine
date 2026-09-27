# Optional: always-on server

The default install runs on your computer and collects while it is awake. For continuous collection, run the same app on a small Linux server. GitHub Pages (static site) and GitHub Actions (CI) are **not** a backend and must not be used as one.

## Requirements

- 1 vCPU / 1–2 GB RAM, ~2 GB disk (SQLite + PGLite brains grow with collected material)
- Bun ≥ 1.1, Git, GBrain (`bun install -g github:garrytan/gbrain`)

## Steps

```bash
git clone https://github.com/LudoGranger/human-machine && cd human-machine
bun install
HM_DATA_DIR=/var/lib/human-machine bun run hm init
```

Edit `/var/lib/human-machine/.env` (mode 600):

```bash
HM_HOST=0.0.0.0            # or keep 127.0.0.1 behind a reverse proxy (recommended)
HM_UI_TOKEN=<long random>  # required whenever HM_HOST is not loopback
HM_LLM_PROVIDER=...        # ANTHROPIC_API_KEY for servers (the Claude Code CLI needs an interactive login)
```

systemd unit (`/etc/systemd/system/human-machine.service`):

```ini
[Unit]
Description=Human Machine
After=network-online.target

[Service]
User=hm
Environment=HM_DATA_DIR=/var/lib/human-machine
Environment=PATH=/home/hm/.bun/bin:/usr/bin:/bin
WorkingDirectory=/opt/human-machine
ExecStart=/home/hm/.bun/bin/bun run src/cli.ts serve
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Put TLS in front (Caddy/nginx). Frontends authenticate with `Authorization: Bearer <HM_UI_TOKEN>` (or visit `https://host/login?token=<HM_UI_TOKEN>` once to set a cookie). Agent tokens (`bun run hm agent-token`) work the same remotely; set `HM_URL=https://host` for the skill script and MCP server.

## Operating notes

- Jobs are durable: restarts re-queue jobs left running by a dead worker; idempotency keys prevent duplicate analysis.
- Back up `HM_DATA_DIR` (SQLite + GBrain brains). It contains collected material and private user memory: keep it private.
- Costs: the VPS, plus model usage (bounded by `HM_LLM_DAILY_BUDGET_USD`) and any paid source APIs.
