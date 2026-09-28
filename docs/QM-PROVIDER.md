# Human Machine as a QM memory provider (implemented)

QM ([yc-software/qm](https://github.com/yc-software/qm)) routes memory through `MEMORY_PROVIDER_CONFIG` (docs/memory-providers.md in QM). Human Machine's backend implements the MCP provider contract QM's client speaks:

| QM call | Human Machine endpoint | Behavior |
|---|---|---|
| `POST <base>/token` (form, `grant_type=client_credentials`) | `/token` | Issues a 1-hour bearer token for a registered client |
| `tools/call hm_recall {query, acting_user, max_chars}` | `/mcp` | Cited, dated public evidence for followed people, retrieved **through GBrain**, plus the acting user's own kept notes |
| `tools/call hm_keep {content, acting_user, idempotency_key, captured_at, source}` | `/mcp` | Explicit Keep: private to (deployment owner, acting user), idempotent, written to a private GBrain brain and **read back** before success |

Read-only clients cannot write; public evidence and a person's attributed rules are never modified from QM.

## Set up

```bash
bun run hm connect qm --url https://<reachable-human-machine-host>
```

This (or the lower-level `hm qm-client`) writes four client credentials to `~/.human-machine/qm-client.env` (mode 600) and prints the `MEMORY_PROVIDER_CONFIG` JSON. Put the credentials in QM's secret store as `HM_QM_RO_CLIENT_ID`, `HM_QM_RO_CLIENT_SECRET`, `HM_QM_RW_CLIENT_ID`, `HM_QM_RW_CLIENT_SECRET`, and set `MEMORY_PROVIDER_CONFIG` on the QM deployment. `hm connect qm` prints the exact `qm.config.jsonc` edits; step-by-step guide: [CONNECT.md](CONNECT.md). The Human Machine URL must be reachable from QM's servers (not `127.0.0.1` of a laptop) — see docs/DEPLOY.md.

## Verified

`scripts/verify-qm.ts` drives the backend with **QM's own client code** (`src/mcp/mcp-client.ts`, `src/memory/mcp-memory-provider.ts` from a QM checkout):

```bash
QM_DIR=../qm bun run scripts/verify-qm.ts ~/.human-machine/qm-client.env
```

Result on 2026-09-27: recall returned cited GBrain evidence; keep stored once despite two identical calls; alice sees her note; bob does not; the read-only client cannot write; a wrong secret is rejected.

Not yet verified: a running QM deployment (Slack/web) using this provider end to end.
