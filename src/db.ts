// Durable store (SQLite via bun:sqlite, WAL). This is the system of record for
// provenance, jobs and cursors; GBrain is the connected memory used for
// retrieval (see src/gbrain). Unknown values are stored as NULL, never guessed.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { dataDir } from "./config.ts";

let db: Database | null = null;

export function getDb(path?: string): Database {
  if (db) return db;
  db = new Database(path ?? join(dataDir(), "hm.sqlite"), { create: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

export function closeDb() {
  db?.close();
  db = null;
}

export function now(): string {
  return new Date().toISOString();
}

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    display_name TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE agent_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    label TEXT,
    scope TEXT NOT NULL DEFAULT 'read',
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at TEXT
  );

  -- Identity ------------------------------------------------------------
  CREATE TABLE persons (
    id TEXT PRIMARY KEY,             -- slug, e.g. garry-tan
    name TEXT NOT NULL,
    description TEXT,
    featured INTEGER NOT NULL DEFAULT 0,
    research_status TEXT NOT NULL DEFAULT 'not_started', -- not_started|resolving|needs_clarification|researching|partial|researched|failed
    identity_status TEXT NOT NULL DEFAULT 'unresolved',   -- unresolved|verified|ambiguous|failed
    wikidata_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE identities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL REFERENCES persons(id),
    kind TEXT NOT NULL,              -- wikidata|x|github|youtube|website|blog|medium|linkedin|alias
    value TEXT NOT NULL,
    verified INTEGER NOT NULL DEFAULT 0,
    evidence TEXT,                   -- JSON: where the link came from
    created_at TEXT NOT NULL,
    UNIQUE(person_id, kind, value)
  );
  CREATE TABLE identity_candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT NOT NULL REFERENCES persons(id),
    wikidata_id TEXT NOT NULL,
    label TEXT, description TEXT,
    created_at TEXT NOT NULL
  );

  -- Sources & versions --------------------------------------------------
  CREATE TABLE sources (
    id TEXT PRIMARY KEY,             -- adapter:locator hash
    person_id TEXT NOT NULL REFERENCES persons(id),
    adapter TEXT NOT NULL,
    kind TEXT NOT NULL,              -- social|repo|video|podcast|book|news|blog|official|manual
    locator TEXT NOT NULL,           -- URL / handle / query
    label TEXT,
    mode TEXT NOT NULL,              -- stream|poll|historical|manual
    status TEXT NOT NULL DEFAULT 'pending', -- live|polling|delayed|historical|access_required|failed|pending
    capabilities TEXT NOT NULL DEFAULT '{}',
    auth_required TEXT,
    cursor TEXT,
    poll_interval_s INTEGER NOT NULL DEFAULT 1800,
    daily_budget INTEGER NOT NULL DEFAULT 48,
    used_today INTEGER NOT NULL DEFAULT 0,
    budget_day TEXT,
    last_attempt_at TEXT,
    last_success_at TEXT,
    next_poll_at TEXT,
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    coverage_gaps TEXT NOT NULL DEFAULT '[]',
    etag TEXT, last_modified TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE(person_id, adapter, locator)
  );

  CREATE TABLE items (
    id TEXT PRIMARY KEY,             -- stable: source_id + external id
    source_id TEXT NOT NULL REFERENCES sources(id),
    person_id TEXT NOT NULL REFERENCES persons(id),
    external_id TEXT NOT NULL,
    url TEXT,
    canonical_url TEXT,
    title TEXT,
    author TEXT,
    attribution TEXT NOT NULL,       -- by_subject|about_subject|by_other|repost_by_subject|interview|unknown
    relation TEXT,                   -- post|reply|quote|repost|commit|release|video|episode|book|article|official_document|upload
    extraction TEXT NOT NULL,        -- full|partial|metadata_only
    current_version INTEGER NOT NULL DEFAULT 1,
    occurred_at TEXT,                -- when the statement/event happened (unknown => NULL)
    published_at TEXT,
    source_updated_at TEXT,
    discovered_at TEXT NOT NULL,
    fetched_at TEXT,
    deleted_at TEXT,
    retracted_at TEXT,
    cluster_id TEXT,                 -- dedupe cluster (syndication / same event)
    is_historical INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(source_id, external_id)
  );
  CREATE INDEX items_person ON items(person_id, discovered_at);

  CREATE TABLE item_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id TEXT NOT NULL REFERENCES items(id),
    version INTEGER NOT NULL,
    content TEXT,
    content_hash TEXT NOT NULL,
    raw TEXT,                        -- provider payload subset (JSON)
    fetched_at TEXT NOT NULL,
    reason TEXT NOT NULL,            -- initial|edit|correction|refetch
    UNIQUE(item_id, version)
  );
  CREATE INDEX item_versions_hash ON item_versions(content_hash);

  CREATE TABLE passages (
    id TEXT PRIMARY KEY,             -- item_id#v#n
    item_id TEXT NOT NULL REFERENCES items(id),
    version INTEGER NOT NULL,
    locator TEXT NOT NULL,           -- e.g. "para 3", "00:12:31-00:13:02", "ch.4 p.88", "commit abc123 README.md"
    speaker TEXT,                    -- NULL when unknown
    speaker_is_subject INTEGER,      -- 1/0/NULL(unknown)
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX passages_item ON passages(item_id);

  -- Evidence model ------------------------------------------------------
  CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    topic TEXT NOT NULL,
    kind TEXT NOT NULL,              -- position|method|decision|experiment|prediction
    statement TEXT NOT NULL,         -- paraphrase, attributed
    status TEXT NOT NULL DEFAULT 'provisional', -- provisional|established|superseded|retracted|stale
    version INTEGER NOT NULL DEFAULT 1,
    first_evidence_at TEXT,          -- earliest occurred/published date of support
    last_evidence_at TEXT,
    superseded_by TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE claim_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claim_id TEXT NOT NULL REFERENCES claims(id),
    version INTEGER NOT NULL,
    statement TEXT NOT NULL,
    status TEXT NOT NULL,
    change_event_id TEXT,
    recorded_at TEXT NOT NULL
  );
  CREATE TABLE claim_evidence (
    claim_id TEXT NOT NULL REFERENCES claims(id),
    passage_id TEXT NOT NULL REFERENCES passages(id),
    relation TEXT NOT NULL,          -- supports|counters|qualifies
    quote TEXT,                      -- exact span from the passage
    PRIMARY KEY (claim_id, passage_id, relation)
  );

  CREATE TABLE decision_cases (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    data TEXT NOT NULL,              -- JSON: situation, goal, constraints, evidence, alternatives, action, reasoning, tradeoffs, outcome, outcome_type
    passage_ids TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE change_events (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    item_id TEXT NOT NULL REFERENCES items(id),
    claim_id TEXT REFERENCES claims(id),
    classification TEXT NOT NULL,    -- new_topic|additional_support|refinement|contradiction|reversal|retraction|repetition|unclear
    summary TEXT NOT NULL,           -- what changed (direct description)
    interpretation TEXT,             -- app interpretation, labelled as such
    passage_ids TEXT NOT NULL,       -- JSON array
    novelty REAL, evidence_quality REAL, usefulness REAL,
    rank_explanation TEXT,
    stale INTEGER NOT NULL DEFAULT 0,
    stale_reason TEXT,
    analyzed_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX change_events_person ON change_events(person_id, analyzed_at);

  CREATE TABLE rules (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'provisional', -- provisional|durable|retired|stale
    attribution TEXT NOT NULL,       -- stated|inferred|adapted
    data TEXT NOT NULL,              -- JSON (see schema.ts RuleData)
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE rule_evidence (
    rule_id TEXT NOT NULL REFERENCES rules(id),
    passage_id TEXT NOT NULL REFERENCES passages(id),
    relation TEXT NOT NULL,          -- supports|counters
    PRIMARY KEY(rule_id, passage_id, relation)
  );

  -- Private user layer --------------------------------------------------
  CREATE TABLE follows (
    user_id TEXT NOT NULL REFERENCES users(id),
    person_id TEXT NOT NULL REFERENCES persons(id),
    goal TEXT NOT NULL,              -- building_with_ai|product_decisions|research|communication|market_policy
    goal_note TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY(user_id, person_id)
  );
  CREATE TABLE cards (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    person_id TEXT NOT NULL REFERENCES persons(id),
    change_event_id TEXT REFERENCES change_events(id),
    rule_id TEXT REFERENCES rules(id),
    goal TEXT NOT NULL,
    data TEXT NOT NULL,              -- JSON card body
    status TEXT NOT NULL DEFAULT 'discovered', -- discovered|tried|supported|inconclusive|rejected|superseded
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE card_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id TEXT NOT NULL REFERENCES cards(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    status TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE experiments (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    card_id TEXT REFERENCES cards(id),
    title TEXT NOT NULL,
    design TEXT NOT NULL,            -- JSON: arms, task split, model, budget, rubric
    status TEXT NOT NULL,            -- planned|running|complete|failed
    results TEXT,                    -- JSON per arm, per split
    decision TEXT,                   -- retain|reject|inconclusive
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE skill_versions (
    id TEXT PRIMARY KEY,
    person_id TEXT NOT NULL REFERENCES persons(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    version INTEGER NOT NULL,
    parent_id TEXT,
    content_hash TEXT NOT NULL,
    manifest TEXT NOT NULL,          -- JSON listing files + provenance
    status TEXT NOT NULL,            -- candidate|retained|rejected|rolled_back
    reason TEXT,
    created_at TEXT NOT NULL
  );

  -- Jobs ------------------------------------------------------------------
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    idempotency_key TEXT UNIQUE,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', -- queued|running|succeeded|failed|cancelled|dead
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    run_after TEXT NOT NULL,
    lease_until TEXT,
    last_error TEXT,
    result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX jobs_ready ON jobs(status, run_after);

  CREATE TABLE events_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE llm_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL, model TEXT, purpose TEXT,
    cost_usd REAL, input_tokens INTEGER, output_tokens INTEGER,
    duration_ms INTEGER, ok INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE gbrain_writes (
    layer TEXT NOT NULL,
    slug TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    written_at TEXT NOT NULL,
    PRIMARY KEY(layer, slug)
  );
  CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at TEXT NOT NULL);
  `,
  `
  ALTER TABLE items ADD COLUMN analysis_status TEXT NOT NULL DEFAULT 'pending'; -- pending|skipped|done|failed|unavailable
  ALTER TABLE items ADD COLUMN analysis_note TEXT;
  ALTER TABLE items ADD COLUMN analyzed_at TEXT;
  ALTER TABLE items ADD COLUMN injection_flag INTEGER NOT NULL DEFAULT 0;
  `,
];

function migrate(d: Database) {
  d.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)");
  const row = d.query("SELECT v FROM schema_version").get() as { v: number } | null;
  let v = row?.v ?? 0;
  if (!row) d.exec("INSERT INTO schema_version (v) VALUES (0)");
  while (v < MIGRATIONS.length) {
    d.transaction(() => {
      d.exec(MIGRATIONS[v]);
      d.query("UPDATE schema_version SET v = ?").run(v + 1);
    })();
    v++;
  }
}

export function kvGet(k: string): string | null {
  const r = getDb().query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null;
  return r?.v ?? null;
}
export function kvSet(k: string, v: string) {
  getDb()
    .query("INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
    .run(k, v, now());
}

export function logEvent(personId: string | null, level: "info" | "warn" | "error", message: string) {
  getDb().query("INSERT INTO events_log (person_id, level, message, created_at) VALUES (?, ?, ?, ?)").run(personId, level, message, now());
}
