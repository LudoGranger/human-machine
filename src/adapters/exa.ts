// Exa web search (https://exa.ai) with the user's own API key.
//  - Finds essays, interviews, talk pages and articles across the open web that
//    the dedicated adapters (X, GitHub, feeds, Federal Register) do not cover.
//  - Attribution is conservative: a result is "by_subject" only when Exa's
//    author field exactly matches the person's name or a known alias. Every
//    other page (including interviews without speaker turns) is reporting
//    about the person and is never analyzed as their statement.
//  - Domains owned by other adapters, and LinkedIn (no authorized access), are
//    excluded so the same material is not collected twice.
// Without EXA_API_KEY the source reports "Access required".
import { config, env } from "../config.ts";
import { safeFetch } from "../net/safeFetch.ts";
import { readCursor, writeCursor } from "./github.ts";
import { isOldAtDiscovery } from "./feeds.ts";
import { AccessRequiredError, type Adapter, type PersonContext, type RawItem, type SourceRow } from "./types.ts";

export const exaApiBase = () => env("HM_EXA_API_BASE") || "https://api.exa.ai";

export const EXA_EXCLUDED_DOMAINS = ["x.com", "twitter.com", "github.com", "youtube.com", "linkedin.com", "news.google.com", "federalregister.gov"];

const RESULTS_PER_POLL = 10;
const MAX_TEXT_CHARS = 20_000;

export interface ExaResult {
  id: string;
  url: string;
  title?: string | null;
  publishedDate?: string | null;
  author?: string | null;
  text?: string | null;
}

export function exaQuery(person: PersonContext): string {
  return `${person.name} essay, interview, talk or article in their own words`;
}

export function isAuthoredBySubject(author: string | null | undefined, person: PersonContext): boolean {
  if (!author) return false;
  const names = [person.name, ...person.aliases].map((n) => n.trim().toLowerCase());
  // Exa may list several authors ("A, B and C"); any exact match counts, a substring does not.
  return author
    .split(/,|;|\band\b|&/i)
    .map((a) => a.trim().toLowerCase())
    .some((a) => names.includes(a));
}

export function exaResultToItem(r: ExaResult, person: PersonContext, source: SourceRow): RawItem {
  const bySubject = isAuthoredBySubject(r.author, person);
  const paras = (r.text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter((p) => p.length > 40)
    .slice(0, 60);
  const t = r.publishedDate ? Date.parse(r.publishedDate) : NaN;
  const published = Number.isFinite(t) ? new Date(t).toISOString() : null;
  const passages = paras.length
    ? paras.map((t, i) => ({
        locator: `para ${i + 1}`,
        text: t.slice(0, 4000),
        speaker: bySubject ? person.name : null,
        speakerIsSubject: bySubject ? true : null,
      }))
    : [{ locator: "title", text: r.title ?? r.url, speaker: null, speakerIsSubject: null }];
  return {
    externalId: r.id || r.url,
    url: r.url,
    title: r.title ?? null,
    author: r.author ?? null,
    attribution: bySubject ? "by_subject" : "about_subject",
    relation: "article",
    extraction: paras.length ? (r.text!.length >= MAX_TEXT_CHARS ? "partial" : "full") : "metadata_only",
    occurredAt: published,
    publishedAt: published,
    updatedAt: null,
    passages,
    raw: { exa_author: r.author ?? null, found_via: "exa" },
    isHistorical: isOldAtDiscovery(published, source),
  };
}

export const exaAdapter: Adapter = {
  id: "exa",
  label: "Web search (Exa, your API key)",
  kind: "blog",
  capabilities: {
    realtime: "poll",
    content: "partial",
    attributionMethod: "By the person only when Exa's author field exactly matches their name or alias; everything else is reporting about them",
    edits: false,
    deletions: false,
    backfill: true,
    notes: [
      "Uses your own Exa account: set EXA_API_KEY (run `hm connect exa`). Each poll is one search billed to that account.",
      "Pages on X, GitHub, YouTube, LinkedIn, Google News and the Federal Register are excluded; dedicated adapters cover them or access is not authorized.",
      "Interviews are stored as reporting unless a speaker-attributed transcript is added.",
    ],
  },
  auth: { required: true, envVars: ["EXA_API_KEY"], paid: true, note: "Your Exa API key (exa.ai dashboard). Without it the source shows Access required." },
  configured: () => !!config.exaKey(),
  async discover(person) {
    return [
      {
        adapter: "exa",
        kind: "blog",
        locator: person.name,
        label: `Web search for ${person.name} (Exa)`,
        mode: "poll",
        pollIntervalS: 24 * 3600,
        dailyBudget: 2,
        coverageGaps: ["Authorship comes from page metadata; unattributed pages are reporting, not statements"],
      },
    ];
  },
  async collect(source, person, signal) {
    const key = config.exaKey();
    if (!key) throw new AccessRequiredError("EXA_API_KEY not configured");
    const cursor = readCursor(source.cursor);
    const body: Record<string, unknown> = {
      query: exaQuery(person),
      type: "auto",
      numResults: RESULTS_PER_POLL,
      excludeDomains: EXA_EXCLUDED_DOMAINS,
      contents: { text: { maxCharacters: MAX_TEXT_CHARS } },
    };
    // After the first run, only ask for pages published since the last newest result.
    if (cursor.newest) body.startPublishedDate = cursor.newest;
    const res = await safeFetch(`${exaApiBase()}/search`, {
      method: "POST",
      headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      maxBytes: 3_000_000,
      signal,
    });
    const j = JSON.parse(res.text) as { results?: ExaResult[] };
    const items: RawItem[] = [];
    let newest = cursor.newest;
    for (const r of j.results ?? []) {
      if (!r.url) continue;
      const it = exaResultToItem(r, person, source);
      if (cursor.seen.includes(it.externalId)) continue;
      items.push(it);
      if (it.publishedAt && (!newest || it.publishedAt > newest)) newest = it.publishedAt;
    }
    return {
      items,
      cursor: writeCursor(cursor, items.map((i) => i.externalId), newest),
      gaps: ["Up to 10 results per daily search; pages behind logins or paywalls are not included"],
      status: "polling",
    };
  },
};
