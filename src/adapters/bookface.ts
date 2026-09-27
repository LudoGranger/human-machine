// YC Bookface via the official YC CLI (`yc`), using the local user's own YC
// login. Bookface is confidential to the YC community, so every item is
// RESTRICTED: stored and analyzed for the local user only, never synced to the
// public GBrain brain, skill exports, QM recall or shared workspaces.
// Only posts whose author is the person are collected (mentions by other
// founders are skipped, not attributed).
import { readCursor, writeCursor } from "./github.ts";
import type { Adapter, RawItem } from "./types.ts";

let meCache: { ok: boolean; at: number } | null = null;

export function ycAvailable(): boolean {
  if (meCache && Date.now() - meCache.at < 10 * 60_000) return meCache.ok;
  const bin = Bun.which("yc");
  const ok = !!bin && Bun.spawnSync([bin, "me"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  meCache = { ok, at: Date.now() };
  return ok;
}

// Minimal RFC 4180 CSV parser (quoted fields may contain newlines and "").
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

const mdLink = (s: string) => s.match(/^\[([\s\S]*?)\]\((https:\/\/bookface\.ycombinator\.com\/[^)]+)\)$/);

export const bookfaceAdapter: Adapter = {
  id: "bookface",
  label: "YC Bookface (restricted, via your YC CLI login)",
  kind: "social",
  capabilities: {
    realtime: "poll",
    content: "full",
    attributionMethod: "Bookface author filter (user.name) + consistent author profile link; mentions by others skipped",
    edits: true,
    deletions: false,
    backfill: false,
    notes: [
      "Requires the YC CLI (`yc login`) and a YC account; available to YC founders only.",
      "Restricted: confidential to the YC community. Kept private to you; never exported, published or shared with QM/other agents.",
      "Latest 10 posts per poll (the search tool's page size).",
    ],
  },
  auth: { required: true, envVars: [], paid: false, note: "YC CLI login (yc login)." },
  configured: ycAvailable,
  async discover(person) {
    if (!ycAvailable()) return [];
    return [{ adapter: "bookface", kind: "social", locator: person.name, label: `Bookface posts by ${person.name} (restricted)`, mode: "poll", pollIntervalS: 3 * 3600, dailyBudget: 12 }];
  },
  async collect(source) {
    const cursor = readCursor(source.cursor);
    const p = Bun.spawn(["yc", "tools", "run", "search", "--input", JSON.stringify({ entity: "forum", query: "", filters: { "user.name": [source.locator] } })], { stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`yc search failed: ${(err || out).slice(0, 200)}`);
    const j = JSON.parse(out.slice(out.indexOf("{")));
    const rows = parseCsv(String(j.csv_results ?? ""));
    // Author consistency: the dominant author profile is the person's account.
    const authors = new Map<string, number>();
    for (const r of rows) authors.set(r["user.link"], (authors.get(r["user.link"]) ?? 0) + 1);
    const main = [...authors.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const items: RawItem[] = [];
    const gaps: string[] = [];
    for (const r of rows) {
      const author = mdLink(r["user.link"] ?? "");
      if (!author || author[1] !== source.locator || r["user.link"] !== main) { gaps.push(`skipped post ${r.id}: author not the person's primary profile`); continue; }
      const key = `${r.id}@${r.posted_at}`;
      if (cursor.seen.includes(key)) continue;
      const title = mdLink(r.link ?? "")?.[1] ?? r.link;
      const paras = String(r.body ?? "").split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x && x !== "uploaded image");
      items.push({
        externalId: r.id,
        url: mdLink(r.link ?? "")?.[2] ?? null,
        title,
        author: source.locator,
        attribution: "by_subject",
        relation: r.item_type === "Comment" ? "reply" : "post",
        extraction: "partial", // search returns an excerpt of the post body
        occurredAt: r.posted_at || null,
        publishedAt: r.posted_at || null,
        updatedAt: null,
        passages: [title, ...paras].slice(0, 40).map((t, i) => ({ locator: i === 0 ? "title" : `para ${i}`, text: t.slice(0, 3000), speaker: source.locator, speakerIsSubject: true })),
        raw: { restricted: true, bookface_id: r.id, author_profile: author[2] },
        isHistorical: r.posted_at ? Date.now() - Date.parse(r.posted_at) > 30 * 86_400_000 : false,
      });
    }
    return { items, cursor: writeCursor(cursor, items.map((i) => `${i.externalId}@${i.publishedAt}`), null), gaps: [...new Set(gaps)].slice(0, 5), status: "polling" };
  },
};
