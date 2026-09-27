# Status — what is live, verified, blocked or unfinished

Snapshot from the build machine, 2026-09-27 (UTC evening). Numbers come from the local database, not estimates.

## Completion criteria

| Requirement | Status | Evidence |
|---|---|---|
| Runnable application (backend) | ✅ | `bun run hm serve` → API + worker on 127.0.0.1:4747; frontend is ChatGPT's scope |
| One person researched with real accessible sources | ✅ Garry Tan | 168 items from 12 live sources (GitHub ×7, blog, YouTube, podcasts, news, books); identity Q23417057 with GitHub/blog/YouTube/X links independently confirmed |
| Visible update from newly ingested material | ✅ | Change events and a card from `garrytan/alphaclaw` commits made 2026-09-27, collected and analyzed the same evening; all six timestamps shown |
| Working GBrain evidence query | ✅ | 399 public / 115 app / 9 private pages written through the GBrain 0.59 CLI; `/api/persons/:id/brain?q=` and every card's `gbrain_support` retrieve through GBrain and map hits back to sources |
| Useful learning card tied to a goal | ✅ | 6 cards for goal *Building with AI* (e.g., split observe/verify steps with leases, from a same-day commit) |
| Desktop skill retrieving dated current context | ✅ | Claude Code 2.1.117, fresh `claude -p` session: loaded `hm-garry-tan`, ran the refresh script, reported `refreshed_at 2026-09-27T22:12:29Z` and the newest change. Stale path verified (exit 4, labelled STALE) |
| Transparent report | ✅ | This file, TESTING.md, BUILD_LOG.md |

## Integrations

| Integration | Implemented | Live access verified | Notes |
|---|---|---|---|
| Wikidata identity | ✅ | ✅ | Ambiguity → clarification (tested); Trump resolved to Q22686 over Donald Trump Jr. |
| GitHub (Atom + patches) | ✅ | ✅ | Author of record; squash-merged changes phrased "committed under X's account" |
| Blog RSS/Atom | ✅ | ✅ | blog.garrytan.com: 30 entries, all older than 30 days → Historical (not reported as new) |
| YouTube channel feed | ✅ | ✅ metadata | Transcripts not collected (captions API needs edit permission) |
| Podcasts (Apple search + transcripts) | ✅ | ✅ metadata | 24 candidate episodes; no publisher transcripts found → not analyzed |
| News (Google News RSS) | ✅ | ✅ | 40 headlines per person, reporting only, never analyzed as statements |
| Books (Open Library) | ✅ | ✅ | Historical metadata only |
| Federal Register | ✅ | ✅ | Trump: 20 presidential documents, official text for recent ones; 12 change events, labelled *official decision* |
| X API v2 (stream, polling, edits, deletions) | ✅ (unit-tested) | ❌ | **No X_BEARER_TOKEN** → all X sources show *Access required*. Paid API |
| LinkedIn | recorded | n/a | No authorized API for others' posts; not scraped |
| Anthropic API provider | ✅ | ❌ | No API key on this machine; the Claude Code CLI provider was used instead |
| Claude Code CLI provider | ✅ | ✅ | 81 calls, reported API-equivalent cost $5.43 (includes the experiment) |
| Local GBrain (3 layers) | ✅ | ✅ | Separate PGLite brains; isolation tested with the real CLI |
| Hosted GBrain workspace (gbrain.io) | ✅ (MCP HTTP client + `hm collab`) | ❌ | Waiting for the workspace access token; not yet exercised |
| Agent API / MCP | ✅ | ✅ | MCP tested over stdio JSON-RPC; not yet inside a Claude Code MCP session |
| **QM memory provider** (`/token` + `/mcp`: `hm_recall`, `hm_keep`) | ✅ | ✅ with QM's own client code | `scripts/verify-qm.ts` imports QM's `mcp-client.ts` + `mcp-memory-provider.ts`: cited GBrain recall, idempotent private keep with read-back, per-user isolation, read-only and bad-secret rejection. **Not yet run inside a deployed QM** (Slack/web) — see docs/QM-PROVIDER.md |
| **YC Bookface** (via YC CLI login) | ✅ | ✅ | 10 of Garry Tan's own posts collected (author-filtered; mentions skipped). **Restricted**: private brain only; excluded from public GBrain, skill export, QM recall and shared pages. Bookface text is sent to your configured analysis model |

## The measured experiment (honest reading)

Task: write a ship/no-ship memo from an experiment log; 6 deterministic checks fixed before running; same model (Claude Opus via CLI), same prompt and token cap; 2 tasks per split.

| Split | A existing | B + fresh context | C + context + method |
|---|---|---|---|
| Development | 4.00 | 4.00 | 4.25 (v0) |
| Validation | 4.50 | 4.90 | **5.50 (v1)** — v0 scored 4.00 |
| Test (run once, after decision) | 3.75 | 4.00 | 6.00 (v1) |

- Decision rule said **retain** v1. But v0 — the procedure extracted from Garry Tan's material — was *worse* than the existing workflow on validation (4.0 vs 4.5). The gain came from steps the improvement loop added to fix failing checks (cite exact numbers, add a stop condition), i.e. generic evidence discipline, not the person's method.
- v1 is stored as a **user adaptation** (private brain); the person's attributed rules were not modified. v2 was rejected (no validation gain).
- n = 2 per split: not statistically meaningful. The "no invented numbers" check also flags legitimately derived numbers (e.g., differences), so it is strict.
- Not measured: user corrections and completion on your own tasks (needs your feedback on cards).

## Known gaps and unfinished work

- X, LinkedIn and full video/podcast transcripts are not covered (access); the API reports them as `access_required` / `metadata_only`.
- Durable rules: 0 so far (every rule has one supporting item; promotion needs ≥2 independent items on different days).
- Market/policy lab (historical event studies) is not built; the product makes no return predictions and takes no trading actions.
- GBrain pages for claims removed during re-analysis are not deleted from the brain (orphans; harmless but untidy).
- DNS rebinding: addresses are checked before connecting, not pinned for the connection.
- No frontend or website in this repository yet: both are ChatGPT's scope (COLLABORATION.md). An earlier interim UI/site built by Claude was removed at the owner's request.
- Windows and non-Claude-Code clients are untested.
