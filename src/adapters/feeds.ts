// Feed-based adapters: the person's own blog/newsletter (RSS/Atom), YouTube
// channel (metadata only), podcast appearances (iTunes Search + episode RSS,
// transcripts only when the publisher provides a podcast:transcript), and news
// reporting (Google News RSS — reporting ABOUT the person, never treated as
// their statement).
import { safeFetch } from "../net/safeFetch.ts";
import { parseFeed, type FeedEntry } from "./feed.ts";
import { readCursor, writeCursor } from "./github.ts";
import type { Adapter, CollectResult, DiscoveredSource, PersonContext, RawItem, RawPassage, SourceRow } from "./types.ts";
import { canonicalUrl, htmlToParagraphs, jaccard, normalizeText } from "../util.ts";

// Items older than this at first collection are baseline history, not "new".
export const BASELINE_WINDOW_DAYS = 30;

export function isOldAtDiscovery(publishedAt: string | null, source: SourceRow): boolean {
  if (!publishedAt) return false;
  const firstRun = !source.last_success_at;
  const ageDays = (Date.now() - Date.parse(publishedAt)) / 86_400_000;
  // Old material is historical on the first run; later, anything published
  // before the source was added is also historical (late discovery).
  return (firstRun && ageDays > BASELINE_WINDOW_DAYS) || Date.parse(publishedAt) < Date.parse(source.created_at) - BASELINE_WINDOW_DAYS * 86_400_000;
}

async function getFeed(url: string, source: SourceRow) {
  const headers: Record<string, string> = { accept: "application/atom+xml, application/rss+xml, application/xml;q=0.9, */*;q=0.5" };
  if (source.etag) headers["if-none-match"] = source.etag;
  if (source.last_modified) headers["if-modified-since"] = source.last_modified;
  return safeFetch(url, { headers });
}

function paragraphsToPassages(paras: string[], speaker: string | null, speakerIsSubject: boolean | null): RawPassage[] {
  return paras.slice(0, 80).map((t, i) => ({ locator: `para ${i + 1}`, text: t.slice(0, 4000), speaker, speakerIsSubject }));
}

export async function autodiscoverFeed(siteUrl: string): Promise<string | null> {
  try {
    const res = await safeFetch(siteUrl, { maxBytes: 2_000_000 });
    if (/^\s*<\?xml|<rss|<feed/i.test(res.text.slice(0, 500))) return res.url;
    const m = res.text.match(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/i);
    const href = m?.[0].match(/href=["']([^"']+)["']/i)?.[1];
    return href ? new URL(href, res.url).toString() : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
export const blogAdapter: Adapter = {
  id: "blog",
  label: "Blog / newsletter (RSS/Atom)",
  kind: "blog",
  capabilities: {
    realtime: "poll",
    content: "full",
    attributionMethod: "Feed is on a site linked to the verified identity; entries treated as authored by the person unless the entry names another author",
    edits: true,
    deletions: false,
    backfill: false,
    notes: ["Feeds usually expose only the most recent entries; older posts are not backfilled.", "An entry whose <updated> changed is stored as a new version, not a new post."],
  },
  auth: { required: false, envVars: [], paid: false, note: "Public feeds." },
  configured: () => true,
  async discover(person) {
    const out: DiscoveredSource[] = [];
    for (const id of person.identities.filter((i) => i.kind === "blog" || i.kind === "website" || i.kind === "medium" || i.kind === "feed")) {
      let feed: string | null = null;
      if (id.kind === "medium") feed = `https://medium.com/feed/@${id.value.replace(/^@/, "")}`;
      else if (id.kind === "feed") feed = id.value;
      else feed = await autodiscoverFeed(id.value);
      if (feed) out.push({ adapter: "blog", kind: "blog", locator: feed, label: `Feed: ${new URL(feed).hostname}`, mode: "poll", pollIntervalS: 3600 });
    }
    return out;
  },
  async collect(source, person) {
    const cursor = readCursor(source.cursor);
    const res = await getFeed(source.locator, source);
    if (res.notModified) return { items: [], cursor: source.cursor, notModified: true, status: "polling" };
    const feed = parseFeed(res.text);
    const names = [person.name, ...person.aliases].map((n) => n.toLowerCase());
    const items: RawItem[] = [];
    const seenKeys: string[] = [];
    for (const e of feed.entries.slice(0, 30)) {
      // Version key includes <updated>: an edited post yields a new version.
      const key = `${e.id}@${e.updated ?? e.published ?? ""}`;
      seenKeys.push(key);
      if (cursor.seen.includes(key)) continue;
      const otherAuthor = e.author && !names.some((n) => e.author!.toLowerCase().includes(n.split(" ").slice(-1)[0]));
      const paras = htmlToParagraphs(e.contentHtml || e.summary);
      items.push({
        externalId: e.id,
        url: e.link,
        title: e.title,
        author: e.author ?? feed.author,
        attribution: otherAuthor ? "by_other" : "by_subject",
        relation: "article",
        extraction: e.contentHtml ? "full" : "partial",
        occurredAt: e.published,
        publishedAt: e.published,
        updatedAt: e.updated,
        passages: paragraphsToPassages(paras.length ? paras : [e.title], otherAuthor ? e.author : person.name, !otherAuthor),
        isHistorical: isOldAtDiscovery(e.published, source),
      });
    }
    return {
      items,
      cursor: writeCursor(cursor, seenKeys, feed.entries[0]?.updated ?? feed.entries[0]?.published ?? null),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      gaps: feed.entries.length >= 30 ? ["Feed has more than 30 entries; only the newest 30 are read per poll"] : [],
      status: "polling",
    };
  },
};

// ---------------------------------------------------------------------------
export const youtubeAdapter: Adapter = {
  id: "youtube",
  label: "YouTube channel",
  kind: "video",
  capabilities: {
    realtime: "poll",
    content: "metadata_only",
    attributionMethod: "Uploads on the channel ID linked to the identity. Uploads are not necessarily the person speaking.",
    edits: true,
    deletions: false,
    backfill: false,
    notes: [
      "Channel Atom feed gives title, description and dates only (latest ~15 uploads).",
      "Transcripts are NOT collected: the official captions.download method requires permission to edit the video. Upload an authorized transcript to analyze a video.",
    ],
  },
  auth: { required: false, envVars: [], paid: false, note: "Public channel feed." },
  configured: () => true,
  async discover(person) {
    return person.identities
      .filter((i) => i.kind === "youtube")
      .map((i) => ({
        adapter: "youtube",
        kind: "video" as const,
        locator: i.value,
        label: `YouTube channel ${i.value}`,
        mode: "poll" as const,
        pollIntervalS: 3600,
        coverageGaps: ["Transcripts unavailable without the publisher's permission; metadata only"],
      }));
  },
  async collect(source) {
    const cursor = readCursor(source.cursor);
    const res = await getFeed(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(source.locator)}`, source);
    if (res.notModified) return { items: [], cursor: source.cursor, notModified: true, status: "polling" };
    const feed = parseFeed(res.text);
    const items: RawItem[] = [];
    for (const e of feed.entries) {
      if (cursor.seen.includes(e.id)) continue;
      items.push({
        externalId: e.videoId ?? e.id,
        url: e.link,
        title: e.title,
        author: e.author,
        attribution: "by_subject",
        relation: "video",
        extraction: "metadata_only",
        occurredAt: null, // recording date unknown
        publishedAt: e.published,
        updatedAt: e.updated,
        passages: [
          { locator: "title", text: e.title, speaker: null, speakerIsSubject: null },
          ...(e.summary ? [{ locator: "description", text: e.summary.slice(0, 4000), speaker: null, speakerIsSubject: null }] : []),
        ],
        isHistorical: isOldAtDiscovery(e.published, source),
      });
    }
    return {
      items,
      cursor: writeCursor(cursor, feed.entries.map((e) => e.id), feed.entries[0]?.published ?? null),
      etag: res.headers.get("etag"),
      gaps: ["Video transcripts not collected (metadata only)"],
      status: "polling",
    };
  },
};

// ---------------------------------------------------------------------------
// Podcast appearances. iTunes Search finds episodes whose metadata mentions the
// person; that proves nothing about who speaks. Transcripts are used only when
// the episode feed publishes one, and speaker labels are kept as given.
export function parseTranscript(body: string, type: string | null, person: PersonContext): RawPassage[] {
  const names = [person.name, ...person.aliases].map((n) => n.toLowerCase());
  const isSubject = (sp: string | null) => (sp ? names.some((n) => sp.toLowerCase().includes(n) || n.includes(sp.toLowerCase())) : null);
  const out: RawPassage[] = [];
  if (type?.includes("json") || body.trim().startsWith("{")) {
    try {
      const j = JSON.parse(body);
      for (const s of j.segments ?? []) {
        const sp = s.speaker ?? null;
        out.push({ locator: `${fmt(s.startTime)}-${fmt(s.endTime)}`, text: String(s.body ?? ""), speaker: sp, speakerIsSubject: isSubject(sp) });
      }
      return mergeSameSpeaker(out);
    } catch {
      /* fall through */
    }
  }
  // WebVTT / SRT with optional <v Speaker> or "Speaker:" prefixes.
  const blocks = body.replace(/\r/g, "").split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split("\n").filter(Boolean);
    const tsIdx = lines.findIndex((l) => /-->/.test(l));
    if (tsIdx < 0) continue;
    const [start, end] = lines[tsIdx].split("-->").map((s) => s.trim().split(" ")[0]);
    let t = lines.slice(tsIdx + 1).join(" ");
    let sp: string | null = null;
    const v = t.match(/^<v\s+([^>]+)>/);
    if (v) {
      sp = v[1].trim();
      t = t.replace(/<v[^>]*>|<\/v>/g, "");
    } else {
      const c = t.match(/^([A-Z][\w .'-]{1,40}):\s/);
      if (c) {
        sp = c[1];
        t = t.slice(c[0].length);
      }
    }
    out.push({ locator: `${start}-${end}`, text: t.replace(/<[^>]+>/g, "").trim(), speaker: sp, speakerIsSubject: isSubject(sp) });
  }
  return mergeSameSpeaker(out);
}
function fmt(s: number | undefined) {
  if (s === undefined) return "?";
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
function mergeSameSpeaker(ps: RawPassage[]): RawPassage[] {
  const out: RawPassage[] = [];
  for (const p of ps) {
    const last = out[out.length - 1];
    if (last && last.speaker === p.speaker && last.text.length < 1500) {
      last.text += " " + p.text;
      last.locator = `${last.locator.split("-")[0]}-${p.locator.split("-")[1]}`;
    } else out.push({ ...p });
  }
  return out;
}

export const podcastAdapter: Adapter = {
  id: "podcasts",
  label: "Podcast appearances",
  kind: "podcast",
  capabilities: {
    realtime: "poll",
    content: "partial",
    attributionMethod: "Episode metadata mentioning the person = appearance candidate. Speaker attribution only from publisher transcript labels.",
    edits: false,
    deletions: false,
    backfill: true,
    notes: [
      "Apple iTunes Search API (no key). Matches are candidates: a mention is not proof of appearance.",
      "Transcripts only when the episode feed publishes <podcast:transcript>. Audio transcription is not performed (no permission assumed).",
    ],
  },
  auth: { required: false, envVars: [], paid: false, note: "Public search API." },
  configured: () => true,
  async discover(person) {
    return [
      {
        adapter: "podcasts",
        kind: "podcast",
        locator: person.name,
        label: `Podcast episodes mentioning "${person.name}"`,
        mode: "poll",
        pollIntervalS: 6 * 3600,
        coverageGaps: ["Audio not transcribed; only publisher-provided transcripts are used"],
      },
    ];
  },
  async collect(source, person) {
    const cursor = readCursor(source.cursor);
    const res = await safeFetch(
      `https://itunes.apple.com/search?term=${encodeURIComponent(source.locator)}&entity=podcastEpisode&limit=25&sort=recent`,
    );
    const j = JSON.parse(res.text);
    const nameRe = new RegExp(person.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const items: RawItem[] = [];
    const gaps: string[] = [];
    for (const r of j.results ?? []) {
      const id = String(r.trackId);
      if (cursor.seen.includes(id)) continue;
      const meta = `${r.trackName ?? ""} ${r.description ?? r.shortDescription ?? ""}`;
      if (!nameRe.test(meta)) continue; // must mention the full name
      let passages: RawPassage[] = [];
      let extraction: RawItem["extraction"] = "metadata_only";
      if (r.feedUrl && r.episodeGuid) {
        try {
          const fr = await safeFetch(r.feedUrl, { maxBytes: 8_000_000 });
          const entry: FeedEntry | undefined = parseFeed(fr.text).entries.find((e) => e.id === r.episodeGuid);
          const t = entry?.transcripts[0];
          if (t) {
            const tr = await safeFetch(t.url, { maxBytes: 5_000_000 });
            passages = parseTranscript(tr.text, t.type, person);
            if (passages.length) extraction = "full";
          }
        } catch (err) {
          gaps.push(`transcript lookup failed for "${r.trackName}": ${(err as Error).message.slice(0, 60)}`);
        }
      }
      if (!passages.length) {
        passages = [
          { locator: "episode title", text: r.trackName ?? "", speaker: null, speakerIsSubject: null },
          { locator: "episode description", text: String(r.description ?? r.shortDescription ?? "").slice(0, 3000), speaker: null, speakerIsSubject: null },
        ];
      }
      items.push({
        externalId: id,
        url: r.trackViewUrl ?? r.episodeUrl ?? null,
        title: `${r.collectionName}: ${r.trackName}`,
        author: r.collectionName ?? null,
        attribution: "interview",
        relation: "episode",
        extraction,
        occurredAt: null,
        publishedAt: r.releaseDate ?? null,
        updatedAt: null,
        passages,
        raw: { collection: r.collectionName, feedUrl: r.feedUrl, has_transcript: extraction === "full" },
        isHistorical: isOldAtDiscovery(r.releaseDate ?? null, source),
      });
    }
    return { items, cursor: writeCursor(cursor, items.map((i) => i.externalId), null), gaps, status: "polling" };
  },
};

// ---------------------------------------------------------------------------
// News: reporting ABOUT the person. Syndicated copies and multiple reports of
// the same event are clustered; statements are never inferred from headlines.
export function clusterKey(title: string, existing: { key: string; title: string }[]): string {
  const base = title.replace(/\s+-\s+[^-]+$/, ""); // strip " - Publisher"
  for (const e of existing) if (jaccard(base, e.title) >= 0.6) return e.key;
  return normalizeText(base).split(" ").slice(0, 8).join("-");
}

export const newsAdapter: Adapter = {
  id: "news",
  label: "News reporting",
  kind: "news",
  capabilities: {
    realtime: "poll",
    content: "metadata_only",
    attributionMethod: "Always 'about_subject' (reporting). Direct quotes are not treated as statements until matched to a primary source.",
    edits: false,
    deletions: false,
    backfill: false,
    notes: ["Google News RSS search (headline, publisher, date).", "Syndicated duplicates are clustered by URL and headline similarity."],
  },
  auth: { required: false, envVars: [], paid: false, note: "Public RSS search." },
  configured: () => true,
  async discover(person) {
    return [{ adapter: "news", kind: "news", locator: `"${person.name}"`, label: `News mentioning "${person.name}"`, mode: "poll", pollIntervalS: 3 * 3600 }];
  },
  async collect(source) {
    const cursor = readCursor(source.cursor);
    const res = await safeFetch(`https://news.google.com/rss/search?q=${encodeURIComponent(source.locator)}&hl=en-US&gl=US&ceid=US:en`);
    const feed = parseFeed(res.text);
    const clusters: { key: string; title: string }[] = [];
    const items: RawItem[] = [];
    for (const e of feed.entries.slice(0, 40)) {
      const key = clusterKey(e.title, clusters);
      if (!clusters.find((c) => c.key === key)) clusters.push({ key, title: e.title });
      if (cursor.seen.includes(e.id)) continue;
      items.push({
        externalId: e.id,
        url: canonicalUrl(e.link),
        title: e.title,
        author: e.sourceName,
        attribution: "about_subject",
        relation: "article",
        extraction: "metadata_only",
        occurredAt: null,
        publishedAt: e.published,
        updatedAt: null,
        passages: [{ locator: "headline", text: e.title, speaker: e.sourceName, speakerIsSubject: false }],
        raw: { cluster: key, publisher: e.sourceName },
        isHistorical: isOldAtDiscovery(e.published, source),
      });
    }
    return { items, cursor: writeCursor(cursor, items.map((i) => i.externalId), null), gaps: ["Headlines only; article bodies not extracted from aggregator links"], status: "polling" };
  },
};
