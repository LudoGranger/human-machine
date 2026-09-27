# Build log (actual timing and provenance)

All times UTC, 2026-09-27. Taken from shell timestamps and the application database, not reconstructed.

| Time | Event |
|---|---|
| 21:36 | Build session starts (Claude Code). Environment inspected: no Bun, no `gh`, no GBrain installed. |
| 21:37–21:40 | GBrain cloned and inspected (v0.59.0.0, commit e78f1c3); Bun 1.4.2 installed; GBrain installed from the clone (`bun link`). CLI and isolation (`GBRAIN_HOME`) verified in a scratch brain. |
| 21:46 | `LudoGranger/human-machine` initial commit (README + MIT LICENSE) created on GitHub by the owner. |
| 21:41–21:55 | Backend written: config, SQLite schema, SSRF-guarded fetch, adapters, identity resolution, ingestion, job queue, GBrain client. |
| 21:56:36 | First person record (Garry Tan) created; identity resolved; 13 sources discovered. |
| 21:56:55 | First real item collected (live public sources). |
| 22:02:12 | First analyzed change event. |
| 22:0x | Crash test: worker killed with jobs in flight; restart recovered them (logged "Recovered 2 job(s)…"). |
| 22:11:43 | First "Put this to work" card (from a commit made the same day). |
| 22:12:02 | First Agent Skills package exported (hm-garry-tan v1). |
| 22:12:29 | Claude Code (`claude -p`, fresh session) used the skill and fetched live, dated context. |

## Pre-existing dependencies (not written during the build)

- GBrain (garrytan/gbrain, MIT) — used as an installed tool, not forked or vendored.
- Bun, zod, fast-xml-parser, @anthropic-ai/sdk, TypeScript (see THIRD_PARTY_NOTICES.md).
- Public data providers: Wikidata, GitHub feeds, YouTube feeds, Apple iTunes Search, Google News RSS, Open Library, Federal Register.

## Originality

All application code in this repository was written during this session. No existing persona application was forked or copied. Two AI agents contribute (see COLLABORATION.md): Claude wrote everything in this commit history's backend; ChatGPT's contributions (frontend/marketing) arrive on separate branches.

## Model usage during the build

Analysis ran through the owner's local Claude Code CLI (`HM_LLM_PROVIDER=claude-cli`). Reported API-equivalent spend is recorded per call in the `llm_usage` table; see STATUS.md for totals.
