// Durable job queue on SQLite. Jobs survive restarts (expired leases are
// re-queued), idempotency keys prevent duplicate analysis, failures back off
// exponentially (or honor a provider's Retry-After), and jobs can be cancelled.
import { getDb, now } from "../db.ts";

export type JobKind = "resolve" | "discover" | "collect" | "analyze" | "gbrain_item" | "profile" | "cards" | "brief";

export interface Job {
  id: number;
  kind: JobKind;
  idempotency_key: string | null;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
}

export function enqueue(kind: JobKind, payload: Record<string, unknown>, opts: { key?: string; runAfter?: Date; maxAttempts?: number } = {}): number | null {
  const db = getDb();
  if (opts.key) {
    const ex = db.query("SELECT id, status FROM jobs WHERE idempotency_key = ?").get(opts.key) as { id: number; status: string } | null;
    if (ex) {
      if (["queued", "running", "succeeded"].includes(ex.status)) return null; // already done or pending
      db.query("UPDATE jobs SET status = 'queued', attempts = 0, run_after = ?, last_error = NULL, updated_at = ? WHERE id = ?").run(
        (opts.runAfter ?? new Date()).toISOString(), now(), ex.id,
      );
      return ex.id;
    }
  }
  const r = db
    .query("INSERT INTO jobs (kind, idempotency_key, payload, max_attempts, run_after, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(kind, opts.key ?? null, JSON.stringify(payload), opts.maxAttempts ?? 5, (opts.runAfter ?? new Date()).toISOString(), now(), now());
  return Number(r.lastInsertRowid);
}

export function claim(kinds?: JobKind[], leaseMs = 5 * 60_000): Job | null {
  const db = getDb();
  return db.transaction(() => {
    const filter = kinds?.length ? `AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const job = db
      .query(`SELECT * FROM jobs WHERE status = 'queued' AND run_after <= ? ${filter} ORDER BY run_after, id LIMIT 1`)
      .get(now(), ...(kinds ?? [])) as Job | null;
    if (!job) return null;
    db.query("UPDATE jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = ?").run(
      new Date(Date.now() + leaseMs).toISOString(), now(), job.id,
    );
    return { ...job, attempts: job.attempts + 1, status: "running" };
  })();
}

export function complete(id: number, result?: unknown) {
  getDb().query("UPDATE jobs SET status = 'succeeded', result = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(
    result === undefined ? null : JSON.stringify(result).slice(0, 4000), now(), id,
  );
}

export function backoffMs(attempt: number, retryAfterS?: number | null): number {
  if (retryAfterS && retryAfterS > 0) return retryAfterS * 1000;
  return Math.min(30_000 * 2 ** (attempt - 1), 60 * 60_000);
}

export function fail(job: Job, err: Error & { retryAfterS?: number | null }, permanent = false) {
  const db = getDb();
  const dead = permanent || job.attempts >= job.max_attempts;
  db.query("UPDATE jobs SET status = ?, last_error = ?, run_after = ?, lease_until = NULL, updated_at = ? WHERE id = ?").run(
    dead ? "dead" : "queued",
    String(err.message).slice(0, 1000),
    new Date(Date.now() + backoffMs(job.attempts, err.retryAfterS)).toISOString(),
    now(),
    job.id,
  );
  return dead;
}

export function cancel(id: number): boolean {
  const r = getDb().query("UPDATE jobs SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued','running')").run(now(), id);
  return r.changes > 0;
}

export function isCancelled(id: number): boolean {
  const r = getDb().query("SELECT status FROM jobs WHERE id = ?").get(id) as { status: string } | null;
  return r?.status === "cancelled";
}

// On startup (or periodically): jobs whose worker died mid-run are re-queued.
export function recoverExpiredLeases(): number {
  const r = getDb()
    .query("UPDATE jobs SET status = 'queued', lease_until = NULL, updated_at = ? WHERE status = 'running' AND (lease_until IS NULL OR lease_until < ?)")
    .run(now(), now());
  return r.changes;
}

export function jobStats(personId?: string) {
  const db = getDb();
  const where = personId ? "WHERE json_extract(payload, '$.personId') = ?" : "";
  return db.query(`SELECT kind, status, COUNT(*) n FROM jobs ${where} GROUP BY kind, status`).all(...(personId ? [personId] : [])) as {
    kind: string;
    status: string;
    n: number;
  }[];
}

// Startup after a crash: if no other worker has a fresh heartbeat, every job
// still marked running belonged to a dead process and is re-queued now.
export function recoverOrphaned(lastHeartbeat: string | null, staleMs = 45_000): number {
  // Heartbeat is "ISO" or "ISO|pid". A fresh heartbeat from a dead pid is stale.
  const [at, pid] = (lastHeartbeat ?? "").split("|");
  let alive = !!at && Date.now() - Date.parse(at) < staleMs;
  if (alive && pid && Number(pid) !== process.pid) {
    try {
      process.kill(Number(pid), 0);
    } catch {
      alive = false;
    }
  }
  if (alive) return 0;
  const r = getDb().query("UPDATE jobs SET status = 'queued', lease_until = NULL, updated_at = ? WHERE status = 'running'").run(now());
  return r.changes;
}
