# Human Machine

**Build an evolving version of yourself, shaped by the humans you pick.**

Pick your team, bring your work, and take both into your AI. [Build your prompt →](https://ludogranger.github.io/human-machine/)

## Your six actions

One entry point: **`/hm`**. These are requests to your AI after installing the skill in Claude Code. In Codex use **`$hm`** instead; in a regular ChatGPT or Claude chat, start with the full prompt from the website. They are not terminal commands.

| Action | What it does | Try it |
|---|---|---|
| [Pick](skills/human-machine-pick/SKILL.md) | Choose people and their roles in your team. | `/hm pick Brian Chesky for design and Garry Tan for early stage` |
| [Catch up](skills/human-machine-catch-up/SKILL.md) | Find their latest relevant public ideas, with sources and dates. | `/hm catch up on what my team has shared about building with AI` |
| [Ask](skills/human-machine-ask/SKILL.md) | Get feedback or draft work using their documented methods. | `/hm ask Brian to review this onboarding flow` |
| [Compare](skills/human-machine-compare/SKILL.md) | See your original alongside alternatives and decide what to use. | `/hm compare my landing page with an approach informed by Brian` |
| [Mix](skills/human-machine-mix/SKILL.md) | Blend selected methods with your own experience and voice. | `/hm mix Brian’s design principles and Garry’s startup advice with my approach` |
| [Keep](skills/human-machine-keep/SKILL.md) | Save a lesson you choose, its context and what happened when you tried it. | `/hm keep this lesson: reducing onboarding to one step improved activation` |

### Try Mix

```text
/hm mix Brian Chesky’s design principles with my own approach.
Here is my onboarding flow: [paste it].
Keep my tone and constraints. Show each proposed change and its source.
Let me accept, adapt or reject it before changing my version.
```

The humans are source-backed perspectives. Your choices, corrections and results shape your evolving practice. Persistent Keep needs a connected private memory tool; otherwise you get a note to save.

**[Set up /hm](docs/SKILLS.md)** · **[Read the entry skill](skills/hm/SKILL.md)** · **[Get the skill pack](https://ludogranger.github.io/human-machine/human-machine-skills.zip)**

## The local application

The [website](https://ludogranger.github.io/human-machine/) gives you one setup prompt to copy into your AI. Pick several public figures, or bring your own material from a friend, parent or colleague. The conversational skill supports those private perspectives; the backend's automated research currently targets public figures. See [skill installation and supported hosts](docs/SKILLS.md).

Human Machine follows what selected people publish, experiment with, change their minds about and put into practice, and turns relevant discoveries into improvements to your daily work with AI. It keeps four questions central: **What changed? Why does it matter to me? What can I try? Did it improve my work?**

> “Thinking” here means an evidence-backed interpretation of public statements and actions. Human Machine never claims access to private thoughts and never implies that a person endorses you or this app.

This repository includes the **local backend**, portable agent skills and the static project website. The backend provides crawler workers, a durable job queue, [GBrain](https://github.com/garrytan/gbrain) memory, an HTTP API, a scoped agent API, an MCP server and a person-specific skill exporter. The website creates setup prompts; it does not expose local runtime data. An application frontend can use [docs/API.md](docs/API.md).

- Honest status of every integration: [STATUS.md](STATUS.md)
- Backend API contract: [docs/API.md](docs/API.md)
- Tests and tested platforms: [TESTING.md](TESTING.md)
- Build timing and provenance: [BUILD_LOG.md](BUILD_LOG.md)

## Install

For the lightweight skill only, use [the `/hm` setup guide](docs/SKILLS.md). The steps below install the local application with source collection and GBrain memory.

Requirements: macOS or Linux, [Bun](https://bun.sh) ≥ 1.1, Git. (Windows: untested.)

```bash
# 1. Bun and GBrain (GBrain is installed from GitHub, never from npm)
curl -fsSL https://bun.sh/install | bash
export PATH="$HOME/.bun/bin:$PATH"
bun install -g github:garrytan/gbrain
gbrain --version

# 2. Human Machine
git clone https://github.com/LudoGranger/human-machine
cd human-machine
bun install
bun run hm init          # creates ~/.human-machine (mode 700), .env template (600), 3 GBrain brains, catalog
bun run hm doctor        # shows what is configured and what is not
```

Choose an analysis model in `~/.human-machine/.env` (without one, material is collected and stored but not analyzed, and the API reports `analysis_status: unavailable`):

```bash
# either: Anthropic API key (paid per use)
ANTHROPIC_API_KEY=sk-ant-...
# or: your locally installed Claude Code CLI (runs with all tools disabled)
HM_LLM_PROVIDER=claude-cli
HM_LLM_DAILY_BUDGET_USD=2
```

Run it:

```bash
bun run hm serve         # backend API on http://127.0.0.1:4747, with the worker
```

Drive it from the CLI (below) or from a frontend that calls the API. To let a frontend on another origin call it, set `HM_CORS_ORIGINS` in `~/.human-machine/.env`.

## Demo flow (what was actually run — see STATUS.md for results)

```bash
bun run hm research "Garry Tan" --wait          # identity → sources → collection → analysis
bun run hm follow garry-tan building_with_ai "I build AI agents for B2B sales"
bun run hm cards garry-tan                      # "Put this to work" cards for that goal
bun run hm brain-search garry-tan "evaluation"  # retrieval through GBrain, mapped to sources
bun run hm agent-token                          # read-only token for desktop agents
bun run hm export-skill garry-tan --install user   # Agent Skills package → ~/.claude/skills
bash ~/.claude/skills/hm-garry-tan/scripts/hm_context.sh context   # dated, fresh context
bun run hm eval garry-tan                       # 3-arm workflow experiment
```

## What is free, what costs money

| Feature | Needs | Cost |
|---|---|---|
| Backend, worker, database, API, agent API, MCP server, skill export | Bun | Free |
| GBrain memory (local PGLite, keyword search) | GBrain CLI | Free |
| GitHub commits/releases/activity, blogs & newsletters (RSS/Atom), YouTube channel metadata, podcast search (Apple), news headlines (Google News RSS), Open Library, Federal Register | Public feeds/APIs | Free |
| Analysis: claims, change detection, rules, learning cards, experiments | `ANTHROPIC_API_KEY` **or** Claude Code CLI | Paid per use, or your Claude plan. Daily budget enforced (`HM_LLM_DAILY_BUDGET_USD`) |
| X posts (polling, filtered stream, edits, deletions) | `X_BEARER_TOKEN` | X API is paid; without it X sources show **Access required** |
| GBrain vector search / reranking | Voyage or OpenAI key configured in GBrain | Paid, optional (not used by default) |
| Hosted GBrain workspace (shared public-evidence brain, agent collaboration) | `GBRAIN_REMOTE_URL` + `GBRAIN_REMOTE_TOKEN` | Per gbrain.io plan, optional |
| Always-on server | A small VPS | Your hosting cost, optional |
| GitHub Actions CI | Public repository | Free (public repos) |

## How it works

```
identity (Wikidata + independent confirmation)
   → discovery (adapters report capabilities, auth, gaps)
   → durable jobs (SQLite: leases, idempotency keys, backoff, budgets, cancellation, restart recovery)
   → fetch through an SSRF guard (public addresses only, every redirect re-checked)
   → normalize: item → versions (content hash) → passages (locator, speaker, speaker_is_subject)
   → dedupe / republished / reporting / repost / historical triage
   → analysis (model output validated; quotes must be verbatim; reversal needs explicit language)
   → claims + versioned position history, decision cases, conditional rules (provisional → durable)
   → GBrain: public / app / private-per-user brains
   → ranked change events → goal-specific "Put this to work" cards
   → experiments (A existing / B + context / C + context + method), versioned skill adaptations
   → agent API · MCP · Agent Skills package with fresh-context refresh
```

### Sources

| Adapter | Access | Real-time | Content | Notes |
|---|---|---|---|---|
| X (API v2) | `X_BEARER_TOKEN` (paid) | filtered stream + since_id polling | full | Reposts ≠ endorsement; quoted text keeps its author; edits → versions; deletions purge text and stale dependent insights. Backfill on reconnect is Enterprise-only, so polling closes gaps |
| GitHub | public Atom + `.patch` | polling | full | Author of record vs other contributors; co-author trailers kept; CHANGELOG/doc additions extracted |
| Blog / newsletter | RSS/Atom | polling | full | Edited posts become versions; old posts found today are *historical* |
| YouTube | channel feed | polling | metadata only | Transcripts not collected: `captions.download` requires edit permission on the video. Upload an authorized transcript instead |
| Podcasts | Apple search + episode RSS | polling | partial | Mentions are candidates; only publisher transcripts (`podcast:transcript`) give speaker-attributed text. No audio transcription |
| News | Google News RSS | polling | headlines | Always *reporting about* the person; syndicated copies and same-event reports clustered |
| Books | Open Library (Google Books optional) | none | metadata | Historical context only. Full text only if public domain, licensed, or your authorized upload with edition/page references |
| Federal Register | public API | polling | abstracts | Official presidential documents (signed = occurred, published = published) |
| YC Bookface | YC CLI login (`yc login`, YC founders) | polling | excerpts | **Restricted**: the person's own posts only; kept private to you; never exported, published, or shared with QM/other agents |
| LinkedIn | — | — | — | No authorized API for third-party member posts: recorded as **Access required**, not scraped. Paste material manually |
| Manual | pasted URL / upload | — | full | You declare attribution and your right to use it |

Source status reported by the API: **Live · Polling · Delayed · Historical · Access required · Failed**. “Live” is only shown for a connected X stream with a heartbeat in the last 30 seconds.

### GBrain layers

| Layer | Brain | Contents |
|---|---|---|
| Public | `~/.human-machine/gbrain/public` (or a hosted workspace) | evidence pages (quoted as blockquotes), claims with history, rules, person hub |
| App | `~/.human-machine/gbrain/app` | app-generated interpretations and adaptations |
| Private | `~/.human-machine/gbrain/private-<user>` — one brain per user | goals, cards, outcomes, experiment adaptations |

Separate `GBRAIN_HOME` directories mean separate databases; tags are not used as access controls.

### Desktop agents

- **Agent API** (bearer token per user): read context, changes and evidence; keep-scoped tokens also allow `/agent/v1/pick` and `/agent/v1/keep`. See [API permissions](docs/API.md).
- **MCP**: `claude mcp add human-machine -- bun run /path/to/human-machine/src/cli.ts mcp`
- **QM (yc-software/qm) memory provider**: `bun run hm qm-client <label> --url <reachable URL>` prints QM's `MEMORY_PROVIDER_CONFIG`; QM workspaces then recall cited evidence (`hm_recall`) and explicitly keep private notes (`hm_keep`). See [docs/QM-PROVIDER.md](docs/QM-PROVIDER.md).
- **Agent Skills package**: `bun run hm export-skill <person> --install user`. It contains a concise `SKILL.md`, conditional rules, provenance, setup, and `scripts/hm_context.sh`, which fetches fresh context and prints `refreshed_at`. If the app is unreachable it prints the last cached copy explicitly labelled **STALE**. Versions are immutable and can be rolled back.

## Optional: always-on server

See [docs/DEPLOY.md](docs/DEPLOY.md). GitHub Actions runs tests and deploys the static website to GitHub Pages; it does not run the backend.

## Working with two agents

The backend is built by Claude; the frontend, website and marketing by ChatGPT. Code is shared through this repository; the proposed shared GBrain connection has not yet been verified by both agents. See [COLLABORATION.md](COLLABORATION.md).

## Rights

Software: MIT (see [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)). Collected content remains the property of its authors and publishers; nothing collected is committed to this repository.
