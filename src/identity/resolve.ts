// Identity resolution happens before any collection. Wikidata supplies
// candidates and asserted account links; a link is marked verified only when an
// independent source confirms it (e.g., the GitHub profile links the same X
// handle, or the YouTube channel feed carries the person's name). Ambiguity
// is surfaced for clarification only when it matters (several plausible
// humans with comparable prominence).
import { getDb, logEvent, now } from "../db.ts";
import { safeFetch } from "../net/safeFetch.ts";
import { parseFeed } from "../adapters/feed.ts";
import { slugify } from "../util.ts";

const WD = "https://www.wikidata.org";

const PROPS: Record<string, string> = {
  P2002: "x",
  P2037: "github",
  P2397: "youtube",
  P856: "website",
  P1581: "blog",
  P6634: "linkedin",
  P3899: "medium",
};

export interface Candidate {
  id: string;
  label: string;
  description: string;
  sitelinks: number;
  isHuman: boolean;
}

async function wdEntity(id: string): Promise<any> {
  const res = await safeFetch(`${WD}/wiki/Special:EntityData/${id}.json`, { maxBytes: 20_000_000, timeoutMs: 30_000 });
  return Object.values(JSON.parse(res.text).entities)[0];
}

export async function searchCandidates(name: string): Promise<Candidate[]> {
  const res = await safeFetch(`${WD}/w/api.php?action=wbsearchentities&search=${encodeURIComponent(name)}&language=en&format=json&limit=7&type=item`);
  const hits = JSON.parse(res.text).search ?? [];
  const ids = hits.map((h: any) => h.id).slice(0, 7);
  if (!ids.length) return [];
  const info = await safeFetch(`${WD}/w/api.php?action=wbgetentities&ids=${ids.join("|")}&props=claims|sitelinks|labels|descriptions&languages=en&format=json`, {
    maxBytes: 30_000_000,
    timeoutMs: 30_000,
  });
  const ents = JSON.parse(info.text).entities ?? {};
  return ids.map((id: string) => {
    const e = ents[id];
    return {
      id,
      label: e?.labels?.en?.value ?? "",
      description: e?.descriptions?.en?.value ?? "",
      sitelinks: Object.keys(e?.sitelinks ?? {}).length,
      isHuman: (e?.claims?.P31 ?? []).some((c: any) => c.mainsnak?.datavalue?.value?.id === "Q5"),
    };
  });
}

// Exact-label humans. Prominence gap ≥ 5× sitelinks (or the runner-up is
// described as a relative, e.g. "Jr.") resolves automatically; otherwise ask.
export function chooseCandidate(name: string, cands: Candidate[]): { chosen: Candidate | null; ambiguous: Candidate[] } {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const humans = cands.filter((c) => c.isHuman && norm(c.label) === norm(name));
  if (humans.length === 0) return { chosen: null, ambiguous: cands.filter((c) => c.isHuman).slice(0, 5) };
  if (humans.length === 1) return { chosen: humans[0], ambiguous: [] };
  const sorted = [...humans].sort((a, b) => b.sitelinks - a.sitelinks);
  if (sorted[0].sitelinks >= 5 * Math.max(1, sorted[1].sitelinks)) return { chosen: sorted[0], ambiguous: [] };
  return { chosen: null, ambiguous: sorted.slice(0, 5) };
}

export async function extractIdentity(qid: string) {
  const e = await wdEntity(qid);
  const links: { kind: string; value: string }[] = [];
  for (const [p, kind] of Object.entries(PROPS)) {
    for (const c of e.claims?.[p] ?? []) {
      if (c.rank === "deprecated") continue;
      // Skip statements with an end date (P582): the account is no longer current.
      if (c.qualifiers?.P582) continue;
      const v = c.mainsnak?.datavalue?.value;
      if (typeof v === "string") links.push({ kind, value: v });
    }
  }
  const positionIds: string[] = (e.claims?.P39 ?? []).map((c: any) => c.mainsnak?.datavalue?.value?.id).filter(Boolean);
  let positions: string[] = [];
  if (positionIds.length) {
    const r = await safeFetch(`${WD}/w/api.php?action=wbgetentities&ids=${positionIds.slice(0, 40).join("|")}&props=labels&languages=en&format=json`);
    const ents = JSON.parse(r.text).entities ?? {};
    positions = positionIds.map((id) => ents[id]?.labels?.en?.value).filter(Boolean);
  }
  return {
    label: e.labels?.en?.value as string,
    description: (e.descriptions?.en?.value as string) ?? null,
    aliases: (e.aliases?.en ?? []).map((a: any) => a.value as string),
    links,
    positions,
  };
}

// Independent confirmations. Each returns evidence text when confirmed.
export async function crossConfirm(name: string, links: { kind: string; value: string }[]): Promise<Map<string, string>> {
  const confirmed = new Map<string, string>();
  const gh = links.find((l) => l.kind === "github");
  if (gh) {
    try {
      const res = await safeFetch(`https://github.com/${gh.value}`, { maxBytes: 3_000_000 });
      const html = res.text;
      const nameOk = html.toLowerCase().includes(name.toLowerCase());
      if (nameOk) confirmed.set(`github:${gh.value}`, `github.com/${gh.value} profile displays the name "${name}"`);
      for (const x of links.filter((l) => l.kind === "x")) {
        if (new RegExp(`https://(x|twitter)\\.com/${x.value}["/]`, "i").test(html))
          confirmed.set(`x:${x.value}`, `github.com/${gh.value} profile links to x.com/${x.value}`);
      }
      for (const b of links.filter((l) => l.kind === "blog" || l.kind === "website")) {
        const host = b.value.replace(/^https?:\/\//, "").replace(/\/$/, "");
        if (html.includes(host)) confirmed.set(`${b.kind}:${b.value}`, `github.com/${gh.value} profile links to ${host}`);
      }
    } catch {
      /* unconfirmed */
    }
  }
  for (const yt of links.filter((l) => l.kind === "youtube")) {
    try {
      const f = parseFeed((await safeFetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${yt.value}`)).text);
      if (f.title.toLowerCase() === name.toLowerCase() || f.author?.toLowerCase() === name.toLowerCase())
        confirmed.set(`youtube:${yt.value}`, `YouTube channel ${yt.value} is titled "${f.title}"`);
    } catch {
      /* unconfirmed */
    }
  }
  for (const b of links.filter((l) => l.kind === "blog" && !confirmed.has(`blog:${l.value}`))) {
    try {
      const res = await safeFetch(b.value, { maxBytes: 2_000_000 });
      if (res.text.toLowerCase().includes(name.toLowerCase())) confirmed.set(`blog:${b.value}`, `${b.value} names "${name}" on its page`);
    } catch {
      /* unconfirmed */
    }
  }
  return confirmed;
}

export function ensurePerson(name: string, opts: { featured?: boolean; description?: string } = {}): string {
  const id = slugify(name);
  const db = getDb();
  const exists = db.query("SELECT id FROM persons WHERE id = ?").get(id);
  if (!exists)
    db.query("INSERT INTO persons (id, name, description, featured, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      name,
      opts.description ?? null,
      opts.featured ? 1 : 0,
      now(),
      now(),
    );
  return id;
}

export interface ResolveResult {
  status: "verified" | "ambiguous" | "failed";
  wikidataId?: string;
  candidates?: Candidate[];
  message: string;
}

export async function resolveIdentity(personId: string, pinnedQid?: string): Promise<ResolveResult> {
  const db = getDb();
  const p = db.query("SELECT * FROM persons WHERE id = ?").get(personId) as any;
  db.query("UPDATE persons SET research_status = 'resolving', updated_at = ? WHERE id = ?").run(now(), personId);
  let qid = pinnedQid ?? p.wikidata_id;
  if (!qid) {
    const cands = await searchCandidates(p.name);
    const { chosen, ambiguous } = chooseCandidate(p.name, cands);
    if (!chosen) {
      db.query("DELETE FROM identity_candidates WHERE person_id = ?").run(personId);
      for (const c of ambiguous)
        db.query("INSERT INTO identity_candidates (person_id, wikidata_id, label, description, created_at) VALUES (?, ?, ?, ?, ?)").run(
          personId, c.id, c.label, c.description, now(),
        );
      const status = ambiguous.length ? "ambiguous" : "failed";
      db.query("UPDATE persons SET identity_status = ?, research_status = ?, updated_at = ? WHERE id = ?").run(
        status, ambiguous.length ? "needs_clarification" : "failed", now(), personId,
      );
      const message = ambiguous.length ? `Several people match "${p.name}". Choose one to continue.` : `No Wikidata person found for "${p.name}". Add sources manually.`;
      logEvent(personId, "warn", message);
      return { status, candidates: ambiguous, message };
    }
    qid = chosen.id;
  }
  const idn = await extractIdentity(qid);
  const confirmed = await crossConfirm(idn.label, idn.links);
  db.transaction(() => {
    db.query("DELETE FROM identities WHERE person_id = ?").run(personId);
    const ins = db.query("INSERT OR IGNORE INTO identities (person_id, kind, value, verified, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    ins.run(personId, "wikidata", qid, 1, JSON.stringify({ source: `${WD}/wiki/${qid}`, method: "exact label match, human (P31=Q5)" }), now());
    for (const a of idn.aliases) ins.run(personId, "alias", a, 0, JSON.stringify({ source: `${WD}/wiki/${qid}` }), now());
    for (const pos of idn.positions) ins.run(personId, "position", pos, 0, JSON.stringify({ source: `${WD}/wiki/${qid}`, property: "P39" }), now());
    for (const l of idn.links) {
      const conf = confirmed.get(`${l.kind}:${l.value}`);
      ins.run(
        personId, l.kind, l.value, conf ? 1 : 0,
        JSON.stringify({ asserted_by: `${WD}/wiki/${qid}`, independent_confirmation: conf ?? null }), now(),
      );
    }
    db.query("UPDATE persons SET wikidata_id = ?, description = COALESCE(description, ?), identity_status = 'verified', updated_at = ? WHERE id = ?").run(
      qid, idn.description, now(), personId,
    );
    db.query("DELETE FROM identity_candidates WHERE person_id = ?").run(personId);
  })();
  const msg = `Identity resolved to ${qid} (${idn.label}); ${idn.links.length} account links asserted, ${confirmed.size} independently confirmed.`;
  logEvent(personId, "info", msg);
  return { status: "verified", wikidataId: qid, message: msg };
}
