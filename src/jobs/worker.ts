// Worker: executes durable jobs and schedules polling. Safe to kill at any
// point — leases expire and jobs are re-queued; idempotency keys prevent
// double analysis of the same item version.
import { getDb, logEvent, now } from "../db.ts";
import { ADAPTERS, adapterById, personContext } from "../adapters/index.ts";
import { AccessRequiredError, type SourceRow } from "../adapters/types.ts";
import { HttpError } from "../net/safeFetch.ts";
import { claim, complete as completeJob, enqueue, fail, isCancelled, recoverExpiredLeases, recoverOrphaned, type Job, type JobKind } from "./queue.ts";
import { resolveIdentity } from "../identity/resolve.ts";
import { markDeleted, storeItem } from "../pipeline/ingest.ts";
import { analyzeItem } from "../pipeline/analyze.ts";
import { syncClaimsAndRules, syncInterpretation, syncItem } from "../pipeline/brain.ts";
import { generateCards } from "../pipeline/cards.ts";
import { shortHash, sleep } from "../util.ts";
import { config, env } from "../config.ts";
import { startFilteredStream, ensureStreamRule, tweetToItem, xSourceIsLive, type StreamHandle } from "../adapters/x.ts";

export function upsertSources(personId: string, discovered: Awaited<ReturnType<(typeof ADAPTERS)[number]["discover"]>>) {
  const db = getDb();
  for (const d of discovered) {
    const a = adapterById(d.adapter)!;
    const id = `${d.adapter}_${shortHash(personId + d.adapter + d.locator)}`;
    const gaps = [...(d.coverageGaps ?? [])];
    const status = !a.configured() ? "access_required" : d.mode === "historical" ? "historical" : "pending";
    db.query(
      `INSERT INTO sources (id, person_id, adapter, kind, locator, label, mode, status, capabilities, auth_required, poll_interval_s, daily_budget, coverage_gaps, next_poll_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(person_id, adapter, locator) DO UPDATE SET capabilities = excluded.capabilities, auth_required = excluded.auth_required,
         status = CASE WHEN sources.status = 'access_required' AND excluded.status != 'access_required' THEN 'pending' ELSE sources.status END`,
    ).run(
      id, personId, d.adapter, d.kind, d.locator, d.label, d.mode, status, JSON.stringify(a.capabilities),
      a.auth.required ? `${a.auth.envVars.join(", ") || "authorized integration"}${a.auth.paid ? " (paid)" : ""}` : null,
      d.pollIntervalS ?? 1800, d.dailyBudget ?? 48, JSON.stringify(gaps), now(), now(),
    );
  }
}

async function handle(job: Job, streamHandle: StreamHandle | null): Promise<unknown> {
  const p = JSON.parse(job.payload);
  const db = getDb();
  switch (job.kind) {
    case "resolve": {
      const r = await resolveIdentity(p.personId, p.qid);
      if (r.status === "verified") enqueue("discover", { personId: p.personId }, { key: `discover:${p.personId}:${Date.now()}` });
      return r;
    }
    case "discover": {
      const ctx = personContext(p.personId);
      const found = [];
      for (const a of ADAPTERS) {
        try {
          found.push(...(await a.discover(ctx)));
        } catch (err) {
          logEvent(p.personId, "warn", `discovery via ${a.id} failed: ${(err as Error).message.slice(0, 160)}`);
        }
      }
      upsertSources(p.personId, found);
      db.query("UPDATE persons SET research_status = 'researching', updated_at = ? WHERE id = ?").run(now(), p.personId);
      const srcs = db.query("SELECT id FROM sources WHERE person_id = ? AND status != 'access_required' AND enabled = 1").all(p.personId) as { id: string }[];
      for (const s of srcs) enqueue("collect", { sourceId: s.id, personId: p.personId }, { key: `collect:${s.id}:initial` });
      logEvent(p.personId, "info", `Discovered ${found.length} sources (${srcs.length} collectable now)`);
      return { discovered: found.length };
    }
    case "collect":
      return collectSource(p.sourceId, job, streamHandle);
    case "analyze": {
      const r = await analyzeItem(p.itemId, p.version);
      enqueue("profile", { personId: p.personId }, { key: `profile:${p.personId}:${Math.floor(Date.now() / 60_000)}`, runAfter: new Date(Date.now() + 5_000) });
      return r;
    }
    case "gbrain_item":
      return syncItem(p.itemId);
    case "profile": {
      const r = await syncClaimsAndRules(p.personId);
      const evs = db
        .query("SELECT id FROM change_events WHERE person_id = ? AND analyzed_at > ?")
        .all(p.personId, new Date(Date.now() - 24 * 3600_000).toISOString()) as { id: string }[];
      for (const e of evs) await syncInterpretation(e.id);
      const follows = db.query("SELECT user_id FROM follows WHERE person_id = ?").all(p.personId) as { user_id: string }[];
      for (const f of follows) enqueue("cards", { userId: f.user_id, personId: p.personId }, { key: `cards:${f.user_id}:${p.personId}:${Math.floor(Date.now() / 60_000)}` });
      updateResearchStatus(p.personId);
      return r;
    }
    case "cards":
      return generateCards(p.userId, p.personId);
    case "brief": {
      const { runBrief } = await import("../pipeline/brief.ts");
      const b = await runBrief(p.userId);
      return { slug: b.slug, quiet: b.quiet, people: b.people.length };
    }
  }
}

export function updateResearchStatus(personId: string) {
  const db = getDb();
  const s = db.query("SELECT status, last_success_at FROM sources WHERE person_id = ? AND enabled = 1").all(personId) as any[];
  const pending = (db.query("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running') AND json_extract(payload, '$.personId') = ?").get(personId) as any).n;
  const ok = s.filter((x) => x.last_success_at).length;
  const blocked = s.filter((x) => ["access_required", "failed"].includes(x.status)).length;
  const status = pending > 0 ? "researching" : ok === 0 ? (s.length ? "failed" : "not_started") : blocked ? "partial" : "researched";
  db.query("UPDATE persons SET research_status = ?, updated_at = ? WHERE id = ? AND identity_status = 'verified'").run(status, now(), personId);
}

async function collectSource(sourceId: string, job: Job, streamHandle: StreamHandle | null) {
  const db = getDb();
  const src = db.query("SELECT * FROM sources WHERE id = ?").get(sourceId) as SourceRow & { daily_budget: number; used_today: number; budget_day: string | null; poll_interval_s: number; coverage_gaps: string; consecutive_failures: number };
  if (!src) return { skipped: "source removed" };
  const adapter = adapterById(src.adapter)!;
  const today = new Date().toISOString().slice(0, 10);
  if (src.budget_day !== today) db.query("UPDATE sources SET used_today = 0, budget_day = ? WHERE id = ?").run(today, sourceId);
  else if (src.used_today >= src.daily_budget) {
    db.query("UPDATE sources SET status = 'delayed', last_error = 'daily request budget reached', next_poll_at = ? WHERE id = ?").run(`${today}T23:59:59.000Z`, sourceId);
    return { skipped: "budget" };
  }
  db.query("UPDATE sources SET used_today = used_today + 1, last_attempt_at = ? WHERE id = ?").run(now(), sourceId);
  const person = personContext(src.person_id);
  try {
    const res = await adapter.collect(src, person);
    let counts = { new: 0, versions: 0, unchanged: 0, duplicates: 0, analyze: 0, deleted: 0 };
    for (const it of res.items) {
      if (isCancelled(job.id)) break;
      const o = storeItem(src, it);
      if (o.action === "new") counts.new++;
      else if (o.action === "new_version") counts.versions++;
      else if (o.action === "unchanged") counts.unchanged++;
      else counts.duplicates++;
      if (o.action === "unchanged") continue;
      db.query("UPDATE items SET analysis_status = ?, analysis_note = ? WHERE id = ?").run(o.analyze ? "pending" : "skipped", o.analyze ? null : o.reason, o.itemId);
      enqueue("gbrain_item", { itemId: o.itemId, personId: src.person_id }, { key: `gbrain:${o.itemId}:${o.version}` });
      if (o.analyze) {
        counts.analyze++;
        enqueue("analyze", { itemId: o.itemId, version: o.version, personId: src.person_id }, { key: `analyze:${o.itemId}:${o.version}` });
      }
    }
    if (res.deletedExternalIds?.length) {
      const ids = markDeleted(src.id, res.deletedExternalIds);
      counts.deleted = ids.length;
      for (const id of ids) enqueue("gbrain_item", { itemId: id, personId: src.person_id }, { key: `gbrain:${id}:deleted` });
    }
    const gaps = [...new Set([...(JSON.parse(src.coverage_gaps) as string[]).filter((g) => !/this poll|per poll|deferred/i.test(g)), ...(res.gaps ?? [])])].slice(0, 12);
    const status = src.adapter === "x" && xSourceIsLive(src, streamHandle) ? "live" : res.status;
    db.query(
      `UPDATE sources SET cursor = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), last_success_at = ?, status = ?,
       consecutive_failures = 0, last_error = NULL, coverage_gaps = ?, next_poll_at = ? WHERE id = ?`,
    ).run(res.cursor, res.etag ?? null, res.lastModified ?? null, now(), status, JSON.stringify(gaps), new Date(Date.now() + src.poll_interval_s * 1000).toISOString(), sourceId);
    if (counts.new || counts.versions || counts.deleted)
      logEvent(src.person_id, "info", `${src.label}: ${counts.new} new, ${counts.versions} updated, ${counts.duplicates} duplicates, ${counts.deleted} deleted; ${counts.analyze} queued for analysis`);
    updateResearchStatus(src.person_id);
    return counts;
  } catch (err) {
    const e = err as Error;
    if (err instanceof AccessRequiredError) {
      db.query("UPDATE sources SET status = 'access_required', last_error = ?, next_poll_at = ? WHERE id = ?").run(e.message, new Date(Date.now() + 86_400_000).toISOString(), sourceId);
      updateResearchStatus(src.person_id);
      return { accessRequired: e.message };
    }
    const retryAfterS = err instanceof HttpError ? err.retryAfterS : null;
    const rate = err instanceof HttpError && err.status === 429;
    const failures = src.consecutive_failures + 1;
    db.query("UPDATE sources SET consecutive_failures = ?, last_error = ?, status = ?, next_poll_at = ? WHERE id = ?").run(
      failures, e.message.slice(0, 500), rate ? "delayed" : failures >= 3 ? "failed" : "delayed",
      new Date(Date.now() + (retryAfterS ? retryAfterS * 1000 : Math.min(src.poll_interval_s * 1000 * 2 ** failures, 12 * 3600_000))).toISOString(), sourceId,
    );
    updateResearchStatus(src.person_id);
    throw Object.assign(e, { retryAfterS });
  }
}

// One morning brief per user per day (HM_BRIEF_HOUR, local time).
export async function scheduleBriefsAsync() {
  const { dueBriefUsers, briefDate } = await import("../pipeline/brief.ts");
  for (const u of dueBriefUsers()) enqueue("brief", { userId: u }, { key: `brief:${u}:${briefDate()}` });
}
function scheduleBriefs() {
  scheduleBriefsAsync().catch((e) => console.error("brief scheduler", e));
}

export function scheduleDueSources() {
  const db = getDb();
  const due = db
    .query("SELECT id, person_id, next_poll_at FROM sources WHERE enabled = 1 AND status NOT IN ('access_required') AND mode != 'manual' AND (next_poll_at IS NULL OR next_poll_at <= ?)")
    .all(now()) as { id: string; person_id: string; next_poll_at: string | null }[];
  for (const s of due) enqueue("collect", { sourceId: s.id, personId: s.person_id }, { key: `collect:${s.id}:${s.next_poll_at ?? "now"}` });
  // Sources blocked on credentials that are now configured become collectable.
  for (const s of db.query("SELECT id, adapter FROM sources WHERE status = 'access_required'").all() as any[]) {
    if (adapterById(s.adapter)?.configured()) db.query("UPDATE sources SET status = 'pending', next_poll_at = ? WHERE id = ?").run(now(), s.id);
  }
  return due.length;
}

export async function runWorker(opts: { once?: boolean; concurrency?: number; signal?: AbortSignal; lastHeartbeat?: string | null } = {}) {
  const orphaned = recoverOrphaned(opts.lastHeartbeat ?? null);
  if (orphaned) logEvent(null, "warn", `Recovered ${orphaned} job(s) left running by a stopped worker`);
  recoverExpiredLeases();
  let stream: StreamHandle | null = null;
  if (config.xBearer() && env("HM_X_STREAM") === "1") {
    const xs = getDb().query("SELECT * FROM sources WHERE adapter = 'x' AND enabled = 1").all() as SourceRow[];
    for (const s of xs) await ensureStreamRule(s.locator, `hm:${s.person_id}`).catch((e) => logEvent(s.person_id, "error", `X stream rule: ${e.message}`));
    stream = startFilteredStream(async (t, includes) => {
      const author = (includes?.users ?? []).find((u: any) => u.id === t.author_id);
      const src = getDb().query("SELECT * FROM sources WHERE adapter = 'x' AND lower(locator) = lower(?)").get(author?.username ?? "") as SourceRow | null;
      if (!src) return;
      const o = storeItem(src, tweetToItem(t, includes, src.locator, personContext(src.person_id)));
      if (o.analyze) enqueue("analyze", { itemId: o.itemId, version: o.version, personId: src.person_id }, { key: `analyze:${o.itemId}:${o.version}` });
      enqueue("gbrain_item", { itemId: o.itemId, personId: src.person_id }, { key: `gbrain:${o.itemId}:${o.version}` });
      getDb().query("UPDATE sources SET status = 'live', last_success_at = ? WHERE id = ?").run(now(), src.id);
    });
  }
  const loop = async (kinds?: JobKind[]) => {
    let idle = 0;
    while (!opts.signal?.aborted) {
      const job = claim(kinds);
      if (!job) {
        if (opts.once) return;
        idle++;
        await sleep(Math.min(2000 * idle, 5000));
        continue;
      }
      idle = 0;
      try {
        const r = await handle(job, stream);
        if (!isCancelled(job.id)) completeJob(job.id, r);
      } catch (err) {
        const dead = fail(job, err as any);
        const pid = JSON.parse(job.payload).personId ?? null;
        logEvent(pid, dead ? "error" : "warn", `${job.kind} job ${job.id} ${dead ? "failed permanently" : "will retry"}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  };
  const ticker = opts.once
    ? null
    : setInterval(() => {
        try {
          recoverExpiredLeases();
          scheduleDueSources();
          scheduleBriefs();
        } catch (e) {
          console.error("scheduler", e);
        }
      }, 20_000);
  if (!opts.once) scheduleDueSources();
  // General loops may be busy with slow model calls; one loop only takes fast
  // jobs so collection and GBrain sync never wait behind analysis.
  const fast: JobKind[] = ["collect", "gbrain_item", "profile", "resolve", "discover"];
  await Promise.all([...Array.from({ length: opts.concurrency ?? 2 }, () => loop()), loop(fast)]);
  if (ticker) clearInterval(ticker);
  stream?.stop();
}
