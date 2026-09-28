# Connect your own GBrain and QM

Human Machine does not host anything for you. It runs on your computer (or your own server) and plugs into the accounts you already have. Every connection is checked before it is saved, and secrets stay in `~/.human-machine/.env` (mode 600).

| You have | Command | What it proves before saving |
|---|---|---|
| A hosted GBrain workspace (gbrain.io) | `bun run hm connect gbrain` | Lists the workspace's tools, writes a test page and reads it back |
| A QM deployment (web or Slack) | `bun run hm connect qm --url https://<your backend>` | Refuses addresses QM cannot reach; prints the exact QM settings |
| An Exa account | `bun run hm connect exa` | Runs one search with your key |

Without any of them, Human Machine still works: GBrain runs locally (three private PGLite brains) and `/hm` works in Claude Code through the MCP server.

## Your GBrain workspace

1. In gbrain.io, open your workspace → **Settings** → **Use it in your agent** → create an **Access token**.
2. Run the command and paste the token when asked (it is read from the terminal, not from the command line, so it stays out of your shell history):

```bash
bun run hm connect gbrain
```

Use `--url <MCP URL>` if your workspace shows an address other than `https://gbrain.io/mcp`.

3. Restart `bun run hm serve`. `bun run hm doctor` shows `gbrain_remote: configured`.

What goes where: public evidence (what the people you follow published) goes to your workspace under `hm/`. Your goals, learning cards and kept lessons stay in the private brains on your computer. `bun run hm connect gbrain --remove` goes back to local only.

## Your QM deployment

QM calls Human Machine from its own servers, so the backend needs a public HTTPS address. A laptop address (`127.0.0.1`) does not work. Run the backend on a small server first ([DEPLOY.md](DEPLOY.md), or its Fly.io section).

Then, on the machine that runs the backend:

```bash
bun run hm connect qm --url https://<your backend>
```

It creates two client credentials (read, and keep) registered in that backend, saves them to `qm-client.env` (mode 600), and prints the three edits for your QM deployment directory:

1. Append `qm-client.env` to QM's `.env`.
2. Add `MEMORY_PROVIDER_CONFIG` under `env.core` and the four `HM_QM_*` names under `secretEnv.core` in `qm.config.jsonc`.
3. `npm exec qm -- check`, `secrets push`, `up`.

`qm check` lists the four `HM_QM_*` names under required secrets when the config is right (checked with QM CLI 0.1.13). In QM, Human Machine is recall plus explicit Keep for personal scopes; QM's own notebook memory keeps working for everything else.

**Prove it:** in QM web, ask about someone you follow (answers cite dated sources from GBrain), say "remember: <a lesson>", then in a new chat ask what you asked it to remember.

You can also check the provider from your computer with QM's own client code before touching your deployment:

```bash
QM_DIR=../qm HM_URL=https://<your backend> bun run scripts/verify-qm.ts ~/.human-machine/qm-client.env
```
