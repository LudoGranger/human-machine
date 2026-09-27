// Normalization + storage of collected items with provenance. Decides which
// items warrant analysis (new content by the subject) and which are repeats,
// syndicated copies, republished old content, reporting, or deletions.
import { getDb, logEvent, now } from "../db.ts";
import type { RawItem, SourceRow } from "../adapters/types.ts";
import { canonicalUrl, jaccard, sha256, shortHash } from "../util.ts";

export interface StoreOutcome {
  itemId: string;
  version: number;
  action: "new" | "new_version" | "unchanged" | "duplicate" | "republished";
  analyze: boolean;
  reason: string;
}

export function itemContentHash(it: RawItem): string {
  return sha256(it.passages.map((p) => `${p.speaker ?? ""}|${p.text}`).join("\n"));
}

function wantsAnalysis(it: RawItem): { analyze: boolean; reason: string } {
  if (it.isHistorical) return { analyze: false, reason: "historical material (baseline context, not a new development)" };
  if (it.attribution === "about_subject") return { analyze: false, reason: "reporting about the person, not their statement" };
  if (it.attribution === "by_other") return { analyze: false, reason: "authored by another contributor" };
  if (it.attribution === "repost_by_subject") return { analyze: false, reason: "repost: not treated as endorsement or statement" };
  if (it.attribution === "unknown") return { analyze: false, reason: "authorship unknown" };
  if (it.extraction === "metadata_only") return { analyze: false, reason: "metadata only (no statement text to analyze)" };
  const subjectText = it.passages.filter((p) => p.speakerIsSubject !== false).map((p) => p.text).join(" ");
  if (it.attribution === "interview" && !it.passages.some((p) => p.speakerIsSubject === true))
    return { analyze: false, reason: "appearance without speaker-attributed transcript (metadata only)" };
  if (subjectText.trim().length < 40) return { analyze: false, reason: "too little text by the person to analyze" };
  return { analyze: true, reason: "new material by the person" };
}

export function storeItem(source: SourceRow, it: RawItem): StoreOutcome {
  const db = getDb();
  const id = shortHash(`${source.id}|${it.externalId}`);
  const hash = itemContentHash(it);
  const canon = canonicalUrl(it.url);
  const ts = now();
  const existing = db.query("SELECT id, current_version, deleted_at FROM items WHERE id = ?").get(id) as
    | { id: string; current_version: number; deleted_at: string | null }
    | null;

  return db.transaction((): StoreOutcome => {
    if (existing) {
      const last = db.query("SELECT content_hash FROM item_versions WHERE item_id = ? ORDER BY version DESC LIMIT 1").get(id) as { content_hash: string };
      if (last.content_hash === hash) {
        db.query("UPDATE items SET fetched_at = ?, source_updated_at = COALESCE(?, source_updated_at) WHERE id = ?").run(ts, it.updatedAt, id);
        return { itemId: id, version: existing.current_version, action: "unchanged", analyze: false, reason: "same content as stored version" };
      }
      const v = existing.current_version + 1;
      db.query("INSERT INTO item_versions (item_id, version, content, content_hash, raw, fetched_at, reason) VALUES (?, ?, ?, ?, ?, ?, 'edit')").run(
        id, v, it.passages.map((p) => p.text).join("\n\n"), hash, JSON.stringify(it.raw ?? {}), ts,
      );
      db.query("UPDATE items SET current_version = ?, fetched_at = ?, source_updated_at = ?, title = COALESCE(?, title) WHERE id = ?").run(v, ts, it.updatedAt, it.title, id);
      insertPassages(id, v, it);
      const w = wantsAnalysis(it);
      return { itemId: id, version: v, action: "new_version", analyze: w.analyze, reason: `edited/updated source; ${w.reason}` };
    }

    // Same text already stored for this person under another item → republished
    // or syndicated copy. Keep lineage, do not analyze twice.
    const sameHash = db
      .query("SELECT iv.item_id, i.cluster_id FROM item_versions iv JOIN items i ON i.id = iv.item_id WHERE iv.content_hash = ? AND i.person_id = ? LIMIT 1")
      .get(hash, source.person_id) as { item_id: string; cluster_id: string | null } | null;
    const sameUrl = canon
      ? (db.query("SELECT id, cluster_id FROM items WHERE canonical_url = ? AND person_id = ? LIMIT 1").get(canon, source.person_id) as { id: string; cluster_id: string | null } | null)
      : null;
    let cluster: string | null = sameHash?.cluster_id ?? sameHash?.item_id ?? sameUrl?.cluster_id ?? sameUrl?.id ?? null;
    if (!cluster && it.raw?.cluster) {
      // Multiple reports of the same event (news) within 14 days → one cluster.
      const recent = db
        .query("SELECT id, title, cluster_id FROM items WHERE person_id = ? AND relation = ? AND discovered_at > ? AND cluster_id IS NOT NULL")
        .all(source.person_id, it.relation, new Date(Date.now() - 14 * 86_400_000).toISOString()) as any[];
      const hit = recent.find((r) => r.cluster_id === `news:${it.raw!.cluster}` || jaccard(r.title ?? "", it.title ?? "") >= 0.6);
      cluster = hit?.cluster_id ?? null;
    }
    const isDup = !!cluster;
    const ownCluster = cluster ?? (it.raw?.cluster ? `news:${it.raw.cluster}` : id);

    db.query(
      `INSERT INTO items (id, source_id, person_id, external_id, url, canonical_url, title, author, attribution, relation, extraction,
        current_version, occurred_at, published_at, source_updated_at, discovered_at, fetched_at, cluster_id, is_historical, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id, source.id, source.person_id, it.externalId, it.url, canon, it.title, it.author, it.attribution, it.relation, it.extraction,
      it.occurredAt, it.publishedAt, it.updatedAt, ts, ts, ownCluster, it.isHistorical ? 1 : 0, ts,
    );
    db.query("INSERT INTO item_versions (item_id, version, content, content_hash, raw, fetched_at, reason) VALUES (?, 1, ?, ?, ?, ?, 'initial')").run(
      id, it.passages.map((p) => p.text).join("\n\n"), hash, JSON.stringify(it.raw ?? {}), ts,
    );
    insertPassages(id, 1, it);
    if (it.raw?.restricted) db.query("UPDATE items SET restricted = 1 WHERE id = ?").run(id);
    if (isDup) {
      const republished = !!sameHash;
      return {
        itemId: id,
        version: 1,
        action: republished ? "republished" : "duplicate",
        analyze: false,
        reason: republished ? "identical text already stored (republished/syndicated copy)" : "same URL or same event already reported",
      };
    }
    const w = wantsAnalysis(it);
    return { itemId: id, version: 1, action: "new", analyze: w.analyze, reason: w.reason };
  })();
}

function insertPassages(itemId: string, version: number, it: RawItem) {
  for (const p of it.passages) p.text = p.text.toWellFormed().replace(/\u0000/g, "");
  const ins = getDb().query(
    "INSERT OR REPLACE INTO passages (id, item_id, version, locator, speaker, speaker_is_subject, text, text_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  it.passages.forEach((p, n) => {
    ins.run(`${itemId}#v${version}#${n + 1}`, itemId, version, p.locator, p.speaker, p.speakerIsSubject === null ? null : p.speakerIsSubject ? 1 : 0, p.text, sha256(p.text), now());
  });
}

// Deletion/retraction: purge stored text (provider retention rules), keep a
// tombstone for lineage, and mark every derived record stale.
export function markDeleted(sourceId: string, externalIds: string[], reason: "deleted" | "retracted" = "deleted"): string[] {
  const db = getDb();
  const affected: string[] = [];
  for (const ext of externalIds) {
    const id = shortHash(`${sourceId}|${ext}`);
    const it = db.query("SELECT id, person_id FROM items WHERE id = ?").get(id) as { id: string; person_id: string } | null;
    if (!it) continue;
    db.transaction(() => {
      const col = reason === "deleted" ? "deleted_at" : "retracted_at";
      db.query(`UPDATE items SET ${col} = ? WHERE id = ?`).run(now(), id);
      if (reason === "deleted") {
        db.query("UPDATE item_versions SET content = NULL, raw = NULL WHERE item_id = ?").run(id);
        db.query("UPDATE passages SET text = '[removed: deleted by author]' WHERE item_id = ?").run(id);
      }
      propagateStale(id, reason === "deleted" ? "supporting post was deleted by its author" : "supporting source was retracted/corrected");
    })();
    affected.push(id);
    logEvent(it.person_id, "warn", `Item ${id} ${reason}; derived insights marked stale`);
  }
  return affected;
}

export function propagateStale(itemId: string, why: string) {
  const db = getDb();
  db.query("UPDATE change_events SET stale = 1, stale_reason = ? WHERE item_id = ?").run(why, itemId);
  const passageIds = (db.query("SELECT id FROM passages WHERE item_id = ?").all(itemId) as { id: string }[]).map((p) => p.id);
  if (!passageIds.length) return;
  const ph = passageIds.map(() => "?").join(",");
  const claims = db.query(`SELECT DISTINCT claim_id FROM claim_evidence WHERE passage_id IN (${ph}) AND relation = 'supports'`).all(...passageIds) as { claim_id: string }[];
  for (const { claim_id } of claims) {
    // Stale only if no live supporting passage remains.
    const live = db
      .query(
        `SELECT COUNT(*) n FROM claim_evidence ce JOIN passages p ON p.id = ce.passage_id JOIN items i ON i.id = p.item_id
         WHERE ce.claim_id = ? AND ce.relation = 'supports' AND i.deleted_at IS NULL AND i.retracted_at IS NULL`,
      )
      .get(claim_id) as { n: number };
    if (live.n === 0) db.query("UPDATE claims SET status = 'stale', updated_at = ? WHERE id = ?").run(now(), claim_id);
  }
  const rules = db.query(`SELECT DISTINCT rule_id FROM rule_evidence WHERE passage_id IN (${ph})`).all(...passageIds) as { rule_id: string }[];
  for (const { rule_id } of rules) db.query("UPDATE rules SET status = 'stale', updated_at = ? WHERE id = ?").run(now(), rule_id);
  db.query(
    `UPDATE cards SET data = json_set(data, '$.stale', json(?)), updated_at = ? WHERE change_event_id IN (SELECT id FROM change_events WHERE item_id = ?)`,
  ).run(JSON.stringify(why), now(), itemId);
}
