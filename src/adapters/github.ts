// GitHub adapter. Uses public Atom feeds (no API quota) for change detection
// and commit .patch files for message, author, co-author trailers, file list
// and CHANGELOG/doc additions. A GITHUB_TOKEN is optional (REST API for
// discussions/metadata); it is never required for the core feed path.
import { safeFetch } from "../net/safeFetch.ts";
import { parseFeed } from "./feed.ts";
import type { Adapter, CollectResult, DiscoveredSource, PersonContext, RawItem, SourceRow } from "./types.ts";
import { config } from "../config.ts";
import { htmlToParagraphs } from "../util.ts";

const MAX_COMMITS_PER_POLL = 6;

export interface FeedCursor {
  seen: string[];
  newest: string | null;
}
export function readCursor(c: string | null): FeedCursor {
  try {
    return c ? JSON.parse(c) : { seen: [], newest: null };
  } catch {
    return { seen: [], newest: null };
  }
}
export function writeCursor(prev: FeedCursor, ids: string[], newest: string | null): string {
  const seen = [...new Set([...ids, ...prev.seen])].slice(0, 400);
  return JSON.stringify({ seen, newest: newest ?? prev.newest });
}

export interface ParsedPatch {
  sha: string;
  authorName: string | null;
  authorEmail: string | null;
  date: string | null;
  subject: string;
  body: string;
  coAuthors: string[];
  files: string[];
  docAdditions: { file: string; lines: string[] }[];
}

export function parsePatch(p: string): ParsedPatch {
  const headerEnd = p.indexOf("\n---\n");
  const head = headerEnd >= 0 ? p.slice(0, headerEnd) : p;
  const sha = head.match(/^From ([0-9a-f]{40})/m)?.[1] ?? "";
  const from = head.match(/^From: (.*?)(?: <([^>]+)>)?$/m);
  const date = head.match(/^Date: (.*)$/m)?.[1] ?? null;
  const subjM = head.match(/^Subject: (?:\[PATCH[^\]]*\] )?([\s\S]*?)\n\n/m);
  const subject = (subjM?.[1] ?? "").replace(/\n\s+/g, " ").trim();
  const body = subjM ? head.slice(head.indexOf(subjM[0]) + subjM[0].length).trim() : "";
  const coAuthors = [...body.matchAll(/^Co-authored-by:\s*(.+)$/gim)].map((m) => m[1].trim());
  const stat = headerEnd >= 0 ? p.slice(headerEnd + 5, p.indexOf("\ndiff --git") > 0 ? p.indexOf("\ndiff --git") : undefined) : "";
  const files = stat
    .split("\n")
    .map((l) => l.match(/^\s*(\S.*?)\s+\|\s+\d+/)?.[1])
    .filter((x): x is string => !!x);
  const docAdditions: ParsedPatch["docAdditions"] = [];
  for (const m of p.matchAll(/^diff --git a\/(\S+) b\/\S+\n([\s\S]*?)(?=^diff --git |(?![\s\S]))/gm)) {
    const file = m[1];
    if (!/(^|\/)(CHANGELOG|README|CLAUDE|AGENTS|SKILL)\.md$|^docs\/.*\.md$/i.test(file)) continue;
    const lines = m[2]
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1))
      .filter((l) => l.trim().length > 0)
      .slice(0, 60);
    if (lines.length) docAdditions.push({ file, lines });
    if (docAdditions.length >= 3) break;
  }
  return {
    sha,
    authorName: from?.[1]?.trim() ?? null,
    authorEmail: from?.[2]?.trim() ?? null,
    date: date ? new Date(date).toISOString() : null,
    subject,
    body: body.replace(/^Co-authored-by:.*$/gim, "").trim(),
    coAuthors,
    files,
    docAdditions,
  };
}

function subjectIdentity(person: PersonContext) {
  const logins = person.identities.filter((i) => i.kind === "github").map((i) => i.value.toLowerCase());
  const names = [person.name, ...person.aliases].map((n) => n.toLowerCase());
  return { logins, names };
}

export function isSubjectAuthor(person: PersonContext, name: string | null, email: string | null, login?: string | null): boolean | null {
  const { logins, names } = subjectIdentity(person);
  if (login && logins.includes(login.toLowerCase())) return true;
  if (name && (names.includes(name.toLowerCase()) || logins.includes(name.toLowerCase()))) return true;
  if (email && logins.some((l) => email.toLowerCase().startsWith(l + "@") || email.toLowerCase().includes(`+${l}@users.noreply.github.com`)))
    return true;
  if (!name && !email) return null;
  return false;
}

async function conditionalFeed(url: string, source: SourceRow) {
  const headers: Record<string, string> = { accept: "application/atom+xml, application/xml;q=0.9" };
  if (source.etag) headers["if-none-match"] = source.etag;
  if (source.last_modified) headers["if-modified-since"] = source.last_modified;
  return safeFetch(url, { headers });
}

export const githubAdapter: Adapter = {
  id: "github",
  label: "GitHub",
  kind: "repo",
  capabilities: {
    realtime: "poll",
    content: "full",
    attributionMethod: "Commit author name/email from .patch; Co-authored-by trailers recorded; other contributors' commits marked by_other",
    edits: false,
    deletions: false,
    backfill: true,
    notes: [
      "Public Atom feeds; no webhooks for repositories you do not own.",
      "Commits under the person's account may be agent-assisted or squash-merged; co-authors are recorded, not hidden.",
      "Discussions/issues require the REST API (optional GITHUB_TOKEN) and are not collected in this version.",
    ],
  },
  auth: { required: false, envVars: ["GITHUB_TOKEN"], paid: false, note: "Optional token raises REST limits; core path uses public feeds." },
  configured: () => true,

  async discover(person) {
    const out: DiscoveredSource[] = [];
    for (const id of person.identities.filter((i) => i.kind === "github")) {
      const login = id.value;
      out.push({ adapter: "github", kind: "repo", locator: `user:${login}`, label: `github.com/${login} public activity`, mode: "poll", pollIntervalS: 900 });
      // Repositories the person actively pushes to, from their own activity feed.
      try {
        const res = await safeFetch(`https://github.com/${login}.atom`);
        const feed = parseFeed(res.text);
        const counts = new Map<string, number>();
        for (const e of feed.entries) {
          if (!/pushed|created a branch|released|opened a pull request/i.test(e.title)) continue;
          const m = e.link?.match(/github\.com\/([^/]+\/[^/]+)/);
          if (m && m[1].toLowerCase().startsWith(login.toLowerCase() + "/")) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
        }
        for (const [repo] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
          out.push({ adapter: "github", kind: "repo", locator: `repo:${repo}`, label: `${repo} commits`, mode: "poll", pollIntervalS: 900 });
          out.push({ adapter: "github", kind: "repo", locator: `releases:${repo}`, label: `${repo} releases`, mode: "poll", pollIntervalS: 1800 });
        }
      } catch {
        /* discovery is best effort; the user feed source records failures */
      }
    }
    return out;
  },

  async collect(source, person): Promise<CollectResult> {
    const [type, target] = [source.locator.split(":")[0], source.locator.slice(source.locator.indexOf(":") + 1)];
    const cursor = readCursor(source.cursor);
    const url =
      type === "user" ? `https://github.com/${target}.atom` : type === "repo" ? `https://github.com/${target}/commits.atom` : `https://github.com/${target}/releases.atom`;
    const res = await conditionalFeed(url, source);
    if (res.notModified) return { items: [], cursor: source.cursor, notModified: true, status: "polling" };
    const feed = parseFeed(res.text);
    const fresh = feed.entries.filter((e) => !cursor.seen.includes(e.id));
    const items: RawItem[] = [];
    const gaps: string[] = [];

    if (type === "repo") {
      const toFetch = fresh.slice(0, MAX_COMMITS_PER_POLL);
      if (fresh.length > toFetch.length) gaps.push(`${fresh.length - toFetch.length} older commits in feed not expanded this poll (per-poll budget)`);
      for (const e of toFetch) {
        const sha = e.link?.match(/commit\/([0-9a-f]{7,40})/)?.[1] ?? e.id.split("/").pop()!;
        let patch: ParsedPatch | null = null;
        try {
          const pr = await safeFetch(`https://github.com/${target}/commit/${sha}.patch`, { maxBytes: 4_000_000, timeoutMs: 30_000 });
          patch = parsePatch(pr.text);
        } catch (err) {
          gaps.push(`patch for ${sha.slice(0, 10)} unavailable: ${(err as Error).message.slice(0, 80)}`);
        }
        const bySubject = isSubjectAuthor(person, patch?.authorName ?? e.author, patch?.authorEmail ?? null, e.author);
        const passages = [];
        const msg = patch ? [patch.subject, patch.body].filter(Boolean).join("\n\n") : e.title;
        passages.push({ locator: `commit ${sha.slice(0, 10)} message`, text: msg.slice(0, 6000), speaker: patch?.authorName ?? e.author, speakerIsSubject: bySubject });
        for (const d of patch?.docAdditions ?? []) {
          passages.push({
            locator: `commit ${sha.slice(0, 10)} +${d.file}`,
            text: d.lines.join("\n").slice(0, 5000),
            speaker: patch?.authorName ?? null,
            speakerIsSubject: bySubject,
          });
        }
        items.push({
          externalId: sha,
          url: `https://github.com/${target}/commit/${sha}`,
          title: patch?.subject || e.title,
          author: patch?.authorName ?? e.author,
          attribution: bySubject === true ? "by_subject" : bySubject === false ? "by_other" : "unknown",
          relation: "commit",
          extraction: patch ? "full" : "metadata_only",
          occurredAt: patch?.date ?? e.updated,
          publishedAt: e.updated,
          updatedAt: e.updated,
          passages,
          raw: { repo: target, co_authors: patch?.coAuthors ?? [], files: (patch?.files ?? []).slice(0, 60), file_count: patch?.files.length ?? null },
        });
      }
    } else {
      for (const e of fresh.slice(0, 20)) {
        const paras = htmlToParagraphs(e.contentHtml).slice(0, 40);
        const isRelease = type === "releases";
        const starred = /starred/i.test(e.title);
        items.push({
          externalId: e.id,
          url: e.link,
          title: e.title,
          author: e.author,
          attribution: starred ? "repost_by_subject" : isRelease ? (isSubjectAuthor(person, e.author, null) === false ? "by_other" : "by_subject") : "by_subject",
          relation: isRelease ? "release" : starred ? "star" : "activity",
          extraction: isRelease ? "full" : "metadata_only",
          occurredAt: e.updated ?? e.published,
          publishedAt: e.published ?? e.updated,
          updatedAt: e.updated,
          passages: (paras.length ? paras : [e.title]).map((t, i) => ({ locator: `para ${i + 1}`, text: t.slice(0, 3000), speaker: e.author, speakerIsSubject: null })),
          raw: { repo: target },
        });
      }
    }
    const ids = items.map((i) => (type === "repo" ? feed.entries.find((e) => e.link?.includes(i.externalId))?.id ?? i.externalId : i.externalId));
    return {
      items,
      cursor: writeCursor(cursor, ids, feed.entries[0]?.updated ?? null),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      gaps,
      status: "polling",
    };
  },
};

export const githubTokenConfigured = () => !!config.githubToken();
