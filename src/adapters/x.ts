// X (Twitter) adapter against the official X API v2.
//  - Identity: GET /2/users/by/username/:username (must match the identity
//    handle confirmed independently, e.g. Wikidata + GitHub profile link).
//  - Poll/backfill: GET /2/users/:id/tweets with since_id (posts, replies,
//    quotes, reposts). Reposts are stored as repost_by_subject — not endorsement.
//  - Edits: edit_history_tweet_ids; later versions of the same post are stored
//    as new versions of the original item.
//  - Deletions: GET /2/tweets?ids= for recently collected posts; missing posts
//    are marked deleted, their text purged, and derived insights marked stale.
//  - Stream: filtered stream (/2/tweets/search/stream) with a `from:` rule,
//    20 s heartbeat detection and the documented reconnect backoff. Backfill on
//    reconnect is Enterprise-only, so gaps are closed with since_id polling.
// Without X_BEARER_TOKEN every X source reports "Access required".
import { config, env } from "../config.ts";
import { HttpError, safeFetch } from "../net/safeFetch.ts";
import { AccessRequiredError, type Adapter, type CollectResult, type PersonContext, type RawItem, type SourceRow } from "./types.ts";
import { sleep } from "../util.ts";

export const xApiBase = () => env("HM_X_API_BASE") || "https://api.x.com";

const TWEET_FIELDS = "created_at,author_id,referenced_tweets,edit_history_tweet_ids,conversation_id,entities,note_tweet,lang";
const EXPANSIONS = "referenced_tweets.id,referenced_tweets.id.author_id";

async function xGet(path: string, signal?: AbortSignal) {
  const token = config.xBearer();
  if (!token) throw new AccessRequiredError("X_BEARER_TOKEN not configured");
  const res = await safeFetch(`${xApiBase()}${path}`, { headers: { authorization: `Bearer ${token}` }, signal });
  return JSON.parse(res.text);
}

export async function resolveXUser(username: string) {
  const j = await xGet(`/2/users/by/username/${encodeURIComponent(username)}?user.fields=created_at,description,url,verified,name`);
  if (!j.data) throw new Error(`X user @${username} not found`);
  return j.data as { id: string; name: string; username: string; description?: string; url?: string };
}

export function tweetToItem(t: any, includes: any, subjectUsername: string, person: PersonContext): RawItem {
  const ref = (t.referenced_tweets ?? [])[0] as { type: string; id: string } | undefined;
  const refTweet = ref ? (includes?.tweets ?? []).find((x: any) => x.id === ref.id) : null;
  const refAuthor = refTweet ? (includes?.users ?? []).find((u: any) => u.id === refTweet.author_id) : null;
  const history: string[] = t.edit_history_tweet_ids ?? [t.id];
  const originalId = history[0];
  const relation = !ref ? "post" : ref.type === "retweeted" ? "repost" : ref.type === "quoted" ? "quote" : "reply";
  const body = t.note_tweet?.text ?? t.text ?? "";
  const passages = [];
  if (relation === "repost") {
    passages.push({
      locator: `repost of ${ref!.id}`,
      text: refTweet?.text ?? body,
      speaker: refAuthor ? `@${refAuthor.username}` : null,
      speakerIsSubject: false,
    });
  } else {
    passages.push({ locator: `post ${t.id}`, text: body, speaker: `@${subjectUsername}`, speakerIsSubject: true });
    if (refTweet) {
      passages.push({
        locator: `${ref!.type === "quoted" ? "quoted" : "in reply to"} ${ref!.id}`,
        text: refTweet.text,
        speaker: refAuthor ? `@${refAuthor.username}` : null,
        speakerIsSubject: refAuthor ? refAuthor.username.toLowerCase() === subjectUsername.toLowerCase() : null,
      });
    }
  }
  return {
    externalId: originalId,
    url: `https://x.com/${subjectUsername}/status/${t.id}`,
    title: null,
    author: `@${subjectUsername}`,
    attribution: relation === "repost" ? "repost_by_subject" : "by_subject",
    relation,
    extraction: "full",
    occurredAt: t.created_at ?? null,
    publishedAt: t.created_at ?? null,
    updatedAt: history.length > 1 ? t.created_at : null,
    passages,
    raw: {
      id: t.id,
      edit_history: history,
      conversation_id: t.conversation_id,
      links: (t.entities?.urls ?? []).map((u: any) => u.expanded_url).filter(Boolean),
      person: person.id,
    },
  };
}

interface XCursor {
  userId?: string;
  sinceId?: string;
  recent?: string[]; // post ids to re-check for deletion
}

export const xAdapter: Adapter = {
  id: "x",
  label: "X (official API v2)",
  kind: "social",
  capabilities: {
    realtime: "stream",
    content: "full",
    attributionMethod: "Author ID of the verified account; reposts marked repost_by_subject; quoted/replied-to text attributed to its own author",
    edits: true,
    deletions: true,
    backfill: true,
    notes: [
      "Filtered stream: pay-per-use allows 1 connection and core operators; backfill_minutes and redundant connections are Enterprise-only.",
      "Gaps after a disconnect are closed with since_id timeline polling.",
      "Deleted posts are purged from local storage and dependent insights are marked stale.",
    ],
  },
  auth: { required: true, envVars: ["X_BEARER_TOKEN"], paid: true, note: "X API access is paid (pay-per-use or Enterprise). Without a token the source shows Access required." },
  configured: () => !!config.xBearer(),
  async discover(person) {
    return person.identities
      .filter((i) => i.kind === "x")
      .map((i) => ({
        adapter: "x",
        kind: "social" as const,
        locator: i.value.replace(/^@/, ""),
        label: `@${i.value.replace(/^@/, "")} on X`,
        mode: "stream" as const,
        pollIntervalS: 900,
        dailyBudget: 96,
      }));
  },
  async collect(source, person, signal): Promise<CollectResult> {
    const c: XCursor = source.cursor ? JSON.parse(source.cursor) : {};
    if (!c.userId) {
      const u = await resolveXUser(source.locator);
      if (u.username.toLowerCase() !== source.locator.toLowerCase()) throw new Error(`X handle mismatch: asked ${source.locator}, got ${u.username}`);
      c.userId = u.id;
    }
    const params = new URLSearchParams({ max_results: "100", "tweet.fields": TWEET_FIELDS, expansions: EXPANSIONS, "user.fields": "username" });
    if (c.sinceId) params.set("since_id", c.sinceId);
    const items: RawItem[] = [];
    let token: string | undefined;
    let pages = 0;
    do {
      if (token) params.set("pagination_token", token);
      const j = await xGet(`/2/users/${c.userId}/tweets?${params}`, signal);
      for (const t of j.data ?? []) items.push(tweetToItem(t, j.includes, source.locator, person));
      token = j.meta?.next_token;
      if (j.meta?.newest_id && (!c.sinceId || BigInt(j.meta.newest_id) > BigInt(c.sinceId)) && pages === 0) c.sinceId = j.meta.newest_id;
      pages++;
    } while (token && pages < 3);

    // Deletion check on recently collected posts.
    const deleted: string[] = [];
    const recent = [...new Set([...items.map((i) => String(i.raw?.id)), ...(c.recent ?? [])])].slice(0, 100);
    if (c.recent?.length) {
      try {
        const j = await xGet(`/2/tweets?ids=${c.recent.slice(0, 100).join(",")}`, signal);
        for (const e of j.errors ?? []) if (/not.?found|resource-not-found/i.test(`${e.title} ${e.type}`)) deleted.push(String(e.value ?? e.resource_id));
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 429)) throw err;
      }
    }
    c.recent = recent.filter((id) => !deleted.includes(id));
    return {
      items,
      cursor: JSON.stringify(c),
      deletedExternalIds: deleted,
      gaps: pages >= 3 && token ? ["More than 300 new posts since last poll; older ones deferred"] : [],
      status: "polling",
    };
  },
};

// ---------------------------------------------------------------------------
// Filtered stream runner (used by the worker when X_BEARER_TOKEN is set and
// HM_X_STREAM=1). Calls onPost for every matching post; the caller persists it.
export interface StreamHandle {
  stop(): void;
  state(): { connected: boolean; lastHeartbeatAt: string | null; reconnects: number; lastError: string | null };
}

export async function ensureStreamRule(username: string, tag: string) {
  const token = config.xBearer();
  if (!token) throw new AccessRequiredError("X_BEARER_TOKEN not configured");
  const rules = JSON.parse((await safeFetch(`${xApiBase()}/2/tweets/search/stream/rules`, { headers: { authorization: `Bearer ${token}` } })).text);
  const value = `from:${username}`;
  if ((rules.data ?? []).some((r: any) => r.value === value)) return;
  await safeFetch(`${xApiBase()}/2/tweets/search/stream/rules`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ add: [{ value, tag }] }),
  });
}

export function nextBackoffMs(kind: "network" | "http" | "rate_limit", attempt: number): number {
  // Documented strategy: network → linear +250 ms up to 16 s; HTTP → exponential
  // from 5 s up to 320 s; 429 → exponential with a longer initial wait.
  if (kind === "network") return Math.min(250 * (attempt + 1), 16_000);
  if (kind === "http") return Math.min(5_000 * 2 ** attempt, 320_000);
  return Math.min(60_000 * 2 ** attempt, 15 * 60_000);
}

export function startFilteredStream(onPost: (t: any, includes: any) => Promise<void>): StreamHandle {
  let stopped = false;
  let connected = false;
  let lastHeartbeatAt: string | null = null;
  let reconnects = 0;
  let lastError: string | null = null;
  let ctl: AbortController | null = null;

  (async () => {
    let attempt = 0;
    while (!stopped) {
      ctl = new AbortController();
      let watchdog: ReturnType<typeof setInterval> | null = null;
      try {
        const params = new URLSearchParams({ "tweet.fields": TWEET_FIELDS, expansions: EXPANSIONS, "user.fields": "username" });
        const res = await fetch(`${xApiBase()}/2/tweets/search/stream?${params}`, {
          headers: { authorization: `Bearer ${config.xBearer()}` },
          signal: ctl.signal,
        });
        if (res.status === 429) throw Object.assign(new Error("rate limited"), { kind: "rate_limit" });
        if (!res.ok || !res.body) throw Object.assign(new Error(`HTTP ${res.status}`), { kind: "http" });
        connected = true;
        attempt = 0;
        lastHeartbeatAt = new Date().toISOString();
        watchdog = setInterval(() => {
          if (Date.now() - Date.parse(lastHeartbeatAt!) > 20_000) ctl?.abort(); // no data or heartbeat for 20 s
        }, 5_000);
        const reader = res.body.getReader();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          lastHeartbeatAt = new Date().toISOString();
          buf += new TextDecoder().decode(value);
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue; // keep-alive heartbeat
            const msg = JSON.parse(line);
            if (msg.data) await onPost(msg.data, msg.includes);
            else if (msg.errors) lastError = JSON.stringify(msg.errors).slice(0, 300);
          }
        }
        throw Object.assign(new Error("stream ended"), { kind: "network" });
      } catch (err: any) {
        connected = false;
        if (stopped) break;
        lastError = String(err?.message ?? err);
        reconnects++;
        await sleep(nextBackoffMs(err?.kind ?? "network", attempt++));
      } finally {
        if (watchdog) clearInterval(watchdog);
      }
    }
  })();

  return {
    stop() {
      stopped = true;
      ctl?.abort();
    },
    state: () => ({ connected, lastHeartbeatAt, reconnects, lastError }),
  };
}

export function xSourceIsLive(source: SourceRow, handle: StreamHandle | null): boolean {
  const s = handle?.state();
  return !!s?.connected && !!s.lastHeartbeatAt && Date.now() - Date.parse(s.lastHeartbeatAt) < 30_000 && source.adapter === "x";
}
