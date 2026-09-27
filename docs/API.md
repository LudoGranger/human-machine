# Human Machine — backend API contract

Base URL (local install): `http://127.0.0.1:4747`. All responses are JSON. Mutating `/api/*` calls must send `content-type: application/json` (CSRF guard). When the server binds to a non-loopback host, `/api/*` and the UI require `HM_UI_TOKEN` (cookie via `/login?token=…` or `Authorization: Bearer`).

Any frontend (including a redesigned one) should treat every text field that comes from sources as **untrusted data**: render with text escaping, never as HTML.

## Vocabulary (display exactly; do not invent states)

| Field | Values |
|---|---|
| source `display_status` | `live` · `polling` · `delayed` · `historical` · `access_required` · `failed` · `pending` → labels **Live · Polling · Delayed · Historical · Access required · Failed · Queued** |
| person `research_status` | `not_started` · `resolving` · `needs_clarification` · `researching` · `partial` · `researched` · `failed` |
| person `identity_status` | `unresolved` · `verified` · `ambiguous` · `failed` |
| change `classification` | `new_topic` · `additional_support` · `refinement` · `contradiction` · `reversal` · `retraction` · `repetition` · `unclear` |
| item `attribution` | `by_subject` · `about_subject` (reporting) · `by_other` · `repost_by_subject` (not endorsement) · `interview` · `unknown` |
| item `extraction` | `full` · `partial` · `metadata_only` |
| item `analysis_status` | `pending` · `skipped` (with reason) · `done` · `failed` · `unavailable` (no model) |
| card `status` | `discovered` · `tried` · `supported` · `inconclusive` · `rejected` · `superseded` |
| goal | `building_with_ai` · `product_decisions` · `research` · `communication` · `market_policy` |

`live` is only emitted for an X filtered-stream connection with a heartbeat in the last 30 s. Never animate a source as live otherwise.

## Timestamps (six, kept separate)

`occurred_at` (statement/event) · `published_at` · `discovered_at` · `fetched_at` · `analyzed_at` · `delivered_at` (card first returned to the user). `null` = unknown — show "unknown", never substitute another date.

## App API (local user)

| Method | Path | Returns |
|---|---|---|
| GET | `/api/status` | `{llm:{provider,model,spentTodayUsd,dailyBudgetUsd}, gbrain:{layers:[{layer,backend,ok,lastOkAt,lastError,pagesWritten}], remoteConfigured}, adapters:[{id,label,kind,capabilities,auth:{required,envVars,paid,note,configured}}], worker:{lastHeartbeat,alive}, jobs:[{kind,status,n}], goals:{key:label}}` |
| GET | `/api/persons` | `[{id,name,description,featured,research_status,identity_status,wikidata_id,items,changes,sources,last_discovered}]` |
| POST | `/api/persons` `{name}` | `{id}` — starts identity resolution → discovery → collection |
| GET | `/api/persons/:id` | `{person, identities[], candidates[] (when ambiguous), sources[], jobs[], log[], analysis[], follow}` |
| POST | `/api/persons/:id/research` | `{id}` |
| POST | `/api/persons/:id/clarify` `{qid}` | `{ok}` — choose among `candidates` |
| GET | `/api/persons/:id/timeline` | `{changes:[…change + item fields + quote + rank_explanation…], items:[…]}` |
| GET | `/api/persons/:id/profile` | `{claims:[{…, evidence[], history[]}], rules:[{…, data:{principle, activation_conditions[], procedure[], …}, evidence[]}], cases[]}` |
| POST | `/api/persons/:id/follow` `{goal, note?}` | `{ok}` |
| POST | `/api/persons/:id/material` `{url? | text?, title?, attribution, occurredAt?, publishedAt?, locatorPrefix?, rightsNote}` | store outcome |
| GET | `/api/persons/:id/brain?q=` | `{query, hits:[{slug,title,chunk_text,score,itemId,url,publishedAt,attribution}]}` — retrieval **through GBrain** |
| POST | `/api/persons/:id/cards` | `{created, skipped[]}` |
| GET | `/api/cards?person=` | `[{id,status,goal,delivered_at,data:{what_changed, why_it_matters, try_it, success_criterion, limits, learn_with_me[], improve_my_agent:{procedure[],evaluation}, market_policy|null, evidence:{quote,url,title,occurred_at,published_at,discovered_at,analyzed_at,classification}, interpretation, rank:{score,why,goal_relevance}, gbrain_support:{retrieved_at,error,hits[]}, stale?}}]` |
| POST | `/api/cards/:id/status` `{status, note?}` | `{ok}` |
| GET | `/api/experiments` | experiments with per-arm, per-split results |
| GET/POST | `/api/persons/:id/skill` | list versions / export a new version |
| POST | `/api/skills/:id/rollback` | `{ok, path}` |
| POST | `/api/agent-tokens` `{label}` | `{token}` (shown once) |

## Agent API (read-only, `Authorization: Bearer <agent token>`)

| Path | Returns |
|---|---|
| `/agent/v1/persons` | `[{id,name,research_status}]` |
| `/agent/v1/context?person=&goal=` | `{generated_at, person, goal, freshness:{last_discovered_at,last_analyzed_at,sources[]}, gbrain:{ok,error,served_from}, note, methods[], recent_changes[], your_cards[], retrieved_evidence[]}` |
| `/agent/v1/changes?person=&since=ISO` | `{generated_at, since, changes:[{…, evidence:[passages]}]}` |
| `/agent/v1/evidence/:itemId?person=` | item with passages, speakers and all dates |

Write operations (token created with `hm agent-token --write`, scope `read keep`; read-only tokens get 403):

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/agent/v1/pick` | `{name, goal?, note?}` | `{person, goal, note}` — follows a **public** person; research runs in the background after identity verification. Never use for private people |
| POST | `/agent/v1/keep` | `{content, person?, status?, idempotency_key?}` | `{kept, id, duplicate, gbrain_slug, readback}` — private to this user, idempotent, written to the user's private GBrain brain and read back |
| GET | `/agent/v1/keeps?q=` | — | this user's kept notes |

MCP tools (stdio, `hm mcp`): `hm_list_people`, `hm_get_context`, `hm_changes_since`, `hm_get_evidence` (read) and `hm_pick`, `hm_keep`, `hm_list_keeps` (need a keep-scoped token). These back the `/hm` skill's Pick, Catch up, Ask, Compare, Mix and Keep.

Tokens map to one user; one user's goals, cards and kept notes are never visible to another token.
