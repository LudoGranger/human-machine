// Morning brief: for each person the user follows, what they actually shared
// since the last brief (dated, sourced), whether it may touch a lesson the
// user kept from them, and one thing to try today. Quiet days say so: new
// posts are not new learning, and repetitions are left out.
// The brief is private (it mentions the user's lessons): it is written to the
// user's private GBrain brain and served to their own agents only.
import { getDb, kvGet, kvSet } from "../db.ts";
import { recentChanges } from "../app.ts";
import { putPage, quoteUntrusted, yamlStr } from "../gbrain/client.ts";
import { env } from "../config.ts";

const WORTH_READING = ["new_topic", "refinement", "contradiction", "reversal", "retraction", "additional_support"];
const MAY_AFFECT_LESSONS = ["contradiction", "reversal", "retraction", "refinement"];
const PER_PERSON = 3;

export interface BriefPerson {
  person_id: string;
  name: string;
  goal: string;
  changes: { summary: string; classification: string; relation: string | null; url: string | null; published_at: string | null; analyzed_at: string; restricted: boolean }[];
  lessons_to_recheck: { id: string; content: string }[];
  try_today: { try_it: string; success_criterion: string | null; card_id: string } | null;
  skipped_repetitions: number;
}

export interface Brief {
  user_id: string;
  date: string; // YYYY-MM-DD in the user's brief timezone
  since: string;
  generated_at: string;
  people: BriefPerson[];
  quiet: boolean;
  slug: string;
}

const lastKey = (u: string) => `brief_last:${u}`;
const latestKey = (u: string) => `brief_latest:${u}`;

export function briefDate(d = new Date(), tz = env("HM_BRIEF_TZ") || Intl.DateTimeFormat().resolvedOptions().timeZone): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

function localHour(d = new Date(), tz = env("HM_BRIEF_TZ") || Intl.DateTimeFormat().resolvedOptions().timeZone): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(d));
}

export function buildBrief(userId: string, at = new Date()): Brief {
  const db = getDb();
  const since = kvGet(lastKey(userId)) ?? new Date(at.getTime() - 86_400_000).toISOString();
  const follows = db
    .query("SELECT f.person_id, f.goal, p.name FROM follows f JOIN persons p ON p.id = f.person_id WHERE f.user_id = ? AND p.identity_status != 'failed' AND p.research_status != 'failed' ORDER BY p.name")
    .all(userId) as { person_id: string; goal: string; name: string }[];
  const people: BriefPerson[] = [];
  for (const f of follows) {
    const all = recentChanges(f.person_id, since, 200).filter((c: any) => !c.stale);
    const worth = all.filter((c: any) => WORTH_READING.includes(c.classification));
    // One entry per source (a post can yield several claims), most useful first.
    const rank = (c: any) => (MAY_AFFECT_LESSONS.includes(c.classification) ? 1 : 0) + (c.usefulness ?? 0);
    const bySource = new Map<string, any>();
    for (const c of [...worth].sort((a: any, b: any) => rank(b) - rank(a))) {
      const k = c.url ?? c.id;
      if (!bySource.has(k)) bySource.set(k, c);
    }
    const changes = [...bySource.values()].slice(0, PER_PERSON).map((c: any) => ({
      summary: c.summary,
      classification: c.classification,
      relation: c.relation ?? null,
      url: c.url,
      published_at: c.published_at,
      analyzed_at: c.analyzed_at,
      restricted: !!c.restricted,
    }));
    const lessons = worth.some((c: any) => MAY_AFFECT_LESSONS.includes(c.classification))
      ? (db.query("SELECT id, content FROM keeps WHERE user_ns = ? AND content LIKE ? ORDER BY created_at DESC LIMIT 5").all(`user:${userId}`, `[${f.person_id}]%`) as { id: string; content: string }[])
      : [];
    const card = db
      .query("SELECT id, data FROM cards WHERE user_id = ? AND person_id = ? AND created_at > ? AND status = 'discovered' ORDER BY created_at DESC LIMIT 1")
      .get(userId, f.person_id, since) as { id: string; data: string } | null;
    let tryToday: BriefPerson["try_today"] = null;
    if (card) {
      const d = JSON.parse(card.data);
      if (d.try_it) tryToday = { try_it: d.try_it, success_criterion: d.success_criterion ?? null, card_id: card.id };
    }
    people.push({
      person_id: f.person_id,
      name: f.name,
      goal: f.goal,
      changes,
      lessons_to_recheck: lessons.map((k) => ({ id: k.id, content: k.content.slice(0, 300) })),
      try_today: tryToday,
      skipped_repetitions: all.length - worth.length,
    });
  }
  const date = briefDate(at);
  return {
    user_id: userId,
    date,
    since,
    generated_at: at.toISOString(),
    people,
    quiet: people.every((p) => p.changes.length === 0),
    slug: `briefs/${date}`,
  };
}

export function briefMarkdown(b: Brief): string {
  const out = [
    "---",
    `title: ${yamlStr(`Morning brief ${b.date}`)}`,
    "type: note",
    "tags: [human-machine, brief, private]",
    `since: ${yamlStr(b.since)}`,
    `generated_at: ${yamlStr(b.generated_at)}`,
    "---",
    "",
    `# Morning brief — ${b.date}`,
    "",
    `What your humans shared since ${b.since.slice(0, 16).replace("T", " ")} UTC. Summaries are app interpretations of public evidence, not the people's private thoughts or endorsement; open the source before relying on one.`,
    "",
  ];
  if (!b.people.length) out.push("You are not following anyone yet. Pick someone with /hm pick.");
  else if (b.quiet) out.push("Nothing new that matters today.", "");
  for (const p of b.people) {
    out.push(`## ${p.name} (${p.goal.replace(/_/g, " ")})`, "");
    if (!p.changes.length) out.push(`Nothing new that matters${p.skipped_repetitions ? ` (${p.skipped_repetitions} repetition${p.skipped_repetitions > 1 ? "s" : ""} left out)` : ""}.`, "");
    for (const c of p.changes) {
      const when = c.published_at ? `published ${c.published_at.slice(0, 10)}` : "publication date unknown";
      // Say what kind of act it is: an official document is not a post.
      const kind = c.relation === "official_document" ? " · official document" : c.relation ? ` · ${c.relation.replace(/_/g, " ")}` : "";
      out.push(`- **${c.classification.replace(/_/g, " ")}**${kind} · ${when}${c.restricted ? " · restricted source" : ""}${c.url ? ` · ${c.url}` : ""}`);
      out.push(quoteUntrusted(c.summary).replace(/^/gm, "  "));
    }
    if (p.changes.length) out.push("");
    if (p.lessons_to_recheck.length) {
      out.push("**Recheck** — this may change lessons you kept from them:");
      for (const k of p.lessons_to_recheck) out.push(`- ${k.id}: ${k.content.split("\n")[0].slice(0, 160)}`);
      out.push("");
    }
    if (p.try_today) {
      out.push(`**Try today:** ${p.try_today.try_it}`);
      if (p.try_today.success_criterion) out.push(`Success looks like: ${p.try_today.success_criterion}`);
      out.push("");
    }
  }
  return out.join("\n");
}

// Builds, writes to the private brain, then records it as the latest brief.
export async function runBrief(userId: string, at = new Date()): Promise<Brief & { markdown: string }> {
  const b = buildBrief(userId, at);
  const markdown = briefMarkdown(b);
  await putPage(`private:${userId}`, b.slug, markdown);
  kvSet(latestKey(userId), JSON.stringify({ ...b, markdown }));
  kvSet(lastKey(userId), b.generated_at);
  return { ...b, markdown };
}

export function latestBrief(userId: string): (Brief & { markdown: string }) | null {
  const v = kvGet(latestKey(userId));
  return v ? JSON.parse(v) : null;
}

// Called by the worker's scheduler: one brief per user per day, after the
// configured local hour (HM_BRIEF_HOUR, default 7). Returns users enqueued.
export function dueBriefUsers(at = new Date()): string[] {
  const hour = Number(env("HM_BRIEF_HOUR") ?? 7);
  if (env("HM_BRIEF") === "off" || localHour(at) < hour) return [];
  const today = briefDate(at);
  const users = getDb().query("SELECT DISTINCT user_id FROM follows").all() as { user_id: string }[];
  return users.map((u) => u.user_id).filter((u) => latestBrief(u)?.date !== today);
}

