# Using QM with Human Machine

Status: proposed integration, checked against upstream documentation on September 27, 2026. This skill pack does not deploy QM, connect GBrain, or start background jobs. A local checkout of QM is not a running deployment.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| `hm` skill | Pick, Catch up, Ask, Compare, Mix and Keep through one entry point |
| QM | Run agents and research jobs in scoped workspaces, with budgets and credentials configured by the operator |
| GBrain | Store and retrieve dated evidence, user experience and adopted methods |
| GitHub | Version original code, skills and API contracts |

Example: the user asks `hm` to catch up on Brian Chesky's design ideas. A QM task reads fresh context from the Human Machine backend, whose adapters collect, check and store evidence in GBrain. Ask or Compare applies relevant evidence to a real piece of work. Keep saves only the user's chosen adaptation in private memory once an authorized write integration exists. A later update can propose a revision; it never silently changes an adopted rule.

## Recommended product additions

These are proposed Human Machine features enabled by QM building blocks, not features supplied fully built by QM.

| Priority | Experience | QM building block | Human Machine work still needed |
| --- | --- | --- | --- |
| 1 | **Revisit my work.** A relevant new source triggers a proposed improvement to a brief or decision the user chose to track. Show original, proposal, evidence and dates. Keep / edit / dismiss. | Scheduled tasks; inbound webhooks for a later event-driven version | Persist active work and adopted-rule dependencies; relevance filter; draft comparison; explicit adoption |
| 2 | **Work with my humans.** One `/hm` request gets independent, attributed feedback from two chosen perspectives, followed by one useful synthesis. | Durable delegated sessions and scoped project files | Task router, evidence packets, disagreement handling and side-by-side output; enable and verify the required feature flag |
| 3 | **Improve my own method.** Try an adopted lesson on comparable tasks, record corrections/results, propose retaining or revising it. | Durable files, follow-up tasks and scheduled review | Extend the backend's existing experiment loop to user tasks; fixed criteria and human outcomes; private versioned adoption |
| 4 | **Continue where I left off.** Bring the same project context, sources and chosen methods to another connected agent. | Shared scopes and skills; documented GBrain connection | Separate authorized client connections and explicit task handoffs; neither QM nor GBrain automatically joins external desktop chats |

Start with priority 1. A notification must answer all three: what changed, which work it affects, and what concrete change is proposed. Keep ordinary new posts silent. Deduplicate by user, project, source event and work revision; record dismissal so the same suggestion does not keep returning. Mark late-arriving historical sources as historical. Never fabricate a new interview to make the demo work.

For priority 2, use the user's private scope or an explicitly shared project scope as the access boundary. Chosen people are perspectives inside that scope, not actual QM accounts and not authorization identities. Use only relevant perspectives; a large roster should not cause a model call to every person. A parent or friend starts from material the user supplies and stays private. The initial demo can compare sequentially before enabling concurrent sessions.

For priority 3, a user clicking Keep records preference, not effectiveness. The existing backend's small memo experiment reports that its improvements came from generic evidence discipline rather than a demonstrated person-specific advantage. Preserve that distinction. Do not rank humans by fictional intelligence scores or turn a positive model self-rating into proof.

## Findings from the current Claude backend

Read-only inspection found an existing Bun/TypeScript implementation with a durable SQLite job queue, source adapters, change events, GBrain retrieval, goal-specific learning cards, versioned skill export and a bounded three-arm evaluation loop. Its status document reports successful local GBrain and Claude Code skill checks. Those reported runs were not independently repeated in this review. Hosted GBrain remains marked unverified in that document.

Reuse the backend as the single owner of ingestion, source cursors and source analysis. QM should orchestrate project-level work using its outputs. Running a second independent crawler inside QM would duplicate scheduling, attribution and costs.

Available read operations in the backend's MCP server:

- `hm_list_people`
- `hm_get_context` with a person and optional goal
- `hm_changes_since` with a person and date
- `hm_get_evidence` with an item ID

The corresponding bearer-authenticated `/agent/v1/` API is read-only. It does not yet provide a scoped project/team model, task-comparison persistence, source-event subscriptions, or an authenticated Keep operation. Do not expose the browser's loopback write routes as a shortcut. Claude's backend owner should add an explicit user-scoped write operation with idempotency and actual private-memory readback before claiming persistence from QM.

## Smallest useful demo

1. Import `hm` and configure one scoped Human Machine reader in a running QM sandbox. The backend must be reachable from that sandbox; its own `127.0.0.1` is not the user's laptop. Use an authenticated service deployment or a deliberately configured local topology, not an unauthenticated public tunnel.
2. The user picks a researched human, a real brief and one goal. Save a reference and revision of only the work the user chose to share.
3. Read actual context, date coverage and evidence. Produce one usable alternative beside the original. A second perspective can be added only if sourced material is available.
4. On a manual refresh, retrieve changes since the previous successful checkpoint. If nothing relevant changed, say so. If a real change affects the brief or an adopted rule, generate one proposed revision with citations. Label replayed older evidence as a replay.
5. Keep / edit / dismiss is explicit. Until the scoped write endpoint exists, report the selection in the session and provide a portable note; do not claim cross-session persistence.
6. Verify the complete cycle once, then add a single user-authorized QM schedule with bounded calls and silence when no relevant change occurs. Keep ingestion timing owned by the backend worker.

This demo proves the evolution loop: **new evidence → relevant change to real work → user choice → retained learning**. It does not require a new full chat interface or a fleet of celebrity agents.

## Minimal deployment path

1. Start with a working QM deployment and its available execution backend. QM supports Claude Code and Codex harnesses, but support in QM does not join arbitrary existing desktop conversations.
2. Publish this skill pack to GitHub. In QM's **Admin → Skill packs**, register the repository at a pinned commit, inspect the catalog, and import `hm`. The current registry only imports org-shareable skills; configure the pack's scope field override for these generic instructions. Do not publish personal source material as part of the pack. Inspect the normalized catalog before import. Updates require a new pinned ref and re-import.
3. For development coordination, connect a reachable GBrain HTTP service using GBrain's documented QM tool-and-skill recipe. Install the thin client in the sandbox image, register separate OAuth clients for appropriate scopes, and store credentials through the deployment's private mechanism. Keep QM's notebook for task-local recall. For Human Machine product data, prefer the backend's scoped API so its evidence and privacy rules continue to apply.
4. Give public evidence and private personal memory different GBrain sources and enforce grants. Slug prefixes can constrain writes, but do not make reads private inside a shared source. A friend's advice and a user's outcomes must not enter an org-readable source by default.
5. Run one manual source → GBrain write → readback → cited comparison → private adoption cycle. Record source dates, returned record IDs and actual results. Verify a second authorized client can retrieve the shared handoff while an unauthorized scope cannot retrieve private memory.
6. Only after the manual loop works, configure the user's chosen research schedule, authorized connectors and cost limits in QM. Report collection timestamps and failures. Do not label ordinary polling as real-time streaming.

The documented GBrain CLI tool route is the initial integration choice. QM also has a generic MCP memory-provider router, but its argument mapping and authentication must match the actual GBrain tools before using that alternative. Do not configure the retired `BRAIN_*` variables.

## Two agents building the project

Give the frontend and backend agents separate responsibilities and GBrain client identities. Each reads the shared brief, current decisions, API contract and other agent's latest handoff before work. Each writes its own status and append-only handoff with commit, changed interfaces, tests and blockers.

GBrain makes those records retrievable; it does not wake another chat or expose uncommitted code. QM can dispatch tasks running within QM. Existing ChatGPT/Codex and Claude desktop sessions still need their own configured GBrain connection and an explicit handoff or task dispatch mechanism.

## Verification before claiming integration

- QM actually loads `hm` at the recorded Git commit.
- A real authorized source is collected and cited, with publication and collection dates.
- GBrain write and retrieval succeed through the agent's scoped identity.
- An adoption is retrieved on a later task, and private material stays inaccessible to another scope.
- Corrected or deleted evidence can flag dependent interpretations for review.
- Jobs expose failure, freshness and cost rather than silently using stale results.

## Upstream references

- [QM](https://github.com/yc-software/qm)
- [QM skill registry](https://github.com/yc-software/qm/blob/main/docs/skill-registry.md)
- [QM memory providers](https://github.com/yc-software/qm/blob/main/docs/memory-providers.md)
- [QM persistent sessions](https://github.com/yc-software/qm/blob/main/docs/persistent-subagent-sessions.md) — delegation defaults off; completion wakes have additional requirements
- [GBrain integration with QM](https://github.com/garrytan/gbrain/blob/master/docs/integrations/qm-harness.md)
