// Atom / RSS 2.0 parsing shared by the blog, video, podcast, news and GitHub
// adapters. Returns plain data; HTML content is never rendered or executed.
import { arr, isoOrNull, text, xml } from "../util.ts";

export interface FeedEntry {
  id: string;
  link: string | null;
  title: string;
  author: string | null;
  published: string | null;
  updated: string | null;
  contentHtml: string;
  summary: string;
  sourceName: string | null; // RSS <source> (news aggregators)
  enclosureUrl: string | null;
  transcripts: { url: string; type: string | null }[];
  videoId: string | null;
}

export interface ParsedFeed {
  title: string;
  author: string | null;
  entries: FeedEntry[];
}

function linkOf(l: any): string | null {
  for (const x of arr(l)) {
    if (typeof x === "string") return x;
    if (x?.["@_href"] && (!x["@_rel"] || x["@_rel"] === "alternate")) return x["@_href"];
  }
  const first = arr(l)[0] as any;
  return first?.["@_href"] ?? (typeof first === "string" ? first : null);
}

export function parseFeed(body: string): ParsedFeed {
  if (/<!DOCTYPE[^>]*\[/i.test(body)) throw new Error("feed declares inline DTD entities; refusing to parse");
  const doc = xml.parse(body);
  if (doc.feed) {
    const f = doc.feed;
    return {
      title: text(f.title),
      author: text(f.author?.name) || null,
      entries: arr(f.entry).map((e: any) => ({
        id: text(e.id) || linkOf(e.link) || text(e.title),
        link: linkOf(e.link),
        title: text(e.title),
        author: text(arr(e.author)[0]?.name) || null,
        published: isoOrNull(e.published),
        updated: isoOrNull(e.updated),
        contentHtml: text(e.content),
        summary: text(e.summary) || text(e["media:group"]?.["media:description"]),
        sourceName: null,
        enclosureUrl: null,
        transcripts: [],
        videoId: text(e["yt:videoId"]) || null,
      })),
    };
  }
  const ch = doc.rss?.channel ?? doc["rdf:RDF"]?.channel;
  if (!ch) throw new Error("not an RSS/Atom document");
  const items = arr(doc.rss?.channel?.item ?? doc["rdf:RDF"]?.item);
  return {
    title: text(ch.title),
    author: text(ch["itunes:author"]) || null,
    entries: items.map((i: any) => ({
      id: text(i.guid) || text(i.link) || text(i.title),
      link: text(i.link) || null,
      title: text(i.title),
      author: text(i["dc:creator"]) || text(i.author) || text(i["itunes:author"]) || null,
      published: isoOrNull(i.pubDate) ?? isoOrNull(i["dc:date"]),
      updated: null,
      contentHtml: text(i["content:encoded"]) || text(i.description),
      summary: text(i.description) || text(i["itunes:summary"]),
      sourceName: text(i.source) || null,
      enclosureUrl: i.enclosure?.["@_url"] ?? null,
      transcripts: arr(i["podcast:transcript"]).map((t: any) => ({ url: t["@_url"], type: t["@_type"] ?? null })).filter((t) => t.url),
      videoId: null,
    })),
  };
}
