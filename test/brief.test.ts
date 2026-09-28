import { beforeAll, describe, expect, test } from "bun:test";
import { getDb, now } from "../src/db.ts";
import { ensurePerson } from "../src/identity/resolve.ts";
import { storeItem } from "../src/pipeline/ingest.ts";
import { buildBrief, briefMarkdown, dueBriefUsers, runBrief, latestBrief } from "../src/pipeline/brief.ts";
import * as app from "../src/app.ts";
import type { RawItem, SourceRow } from "../src/adapters/types.ts";

const T0 = "2026-09-20T00:00:00.000Z";
let src: SourceRow;

function item(id: string, url: string, relation = "post"): RawItem {
  return {
    externalId: id, url, title: id, author: "Brief Person", attribution: "by_subject", relation, extraction: "full",
    occurredAt: "2026-09-26T10:00:00.000Z", publishedAt: "2026-09-26T10:00:00.000Z", updatedAt: null,
    passages: [{ locator: "p1", text: `Statement ${id} with enough words to be stored and analyzed properly.`, speaker: "Brief Person", speakerIsSubject: true }],
  };
}

function change(id: string, itemId: string, classification: string, summary: string, usefulness: number, analyzedAt = "2026-09-27T12:00:00.000Z") {
  const pid = (getDb().query("SELECT id FROM passages WHERE item_id = ? LIMIT 1").get(itemId) as any).id;
  getDb()
    .query("INSERT INTO change_events (id, person_id, item_id, classification, summary, passage_ids, usefulness, analyzed_at, created_at) VALUES (?, 'brief-person', ?, ?, ?, ?, ?, ?, ?)")
    .run(id, itemId, classification, summary, JSON.stringify([pid]), usefulness, analyzedAt, analyzedAt);
}

beforeAll(() => {
  const db = getDb();
  ensurePerson("Brief Person");
  ensurePerson("Quiet Person");
  app.ensureUser("briefuser");
  db.query("INSERT OR IGNORE INTO sources (id, person_id, adapter, kind, locator, label, mode, status, created_at) VALUES ('brief-src', 'brief-person', 'blog', 'blog', 'loc', 'src', 'poll', 'polling', ?)").run(T0);
  src = db.query("SELECT * FROM sources WHERE id = 'brief-src'").get() as SourceRow;
  app.follow("briefuser", "brief-person", "product_decisions", null);
  app.follow("briefuser", "quiet-person", "communication", null);
  const a = storeItem(src, item("a", "https://b.example.com/post-a"));
  const b = storeItem(src, item("b", "https://b.example.com/order", "official_document"));
  const c = storeItem(src, item("c", "https://b.example.com/post-c"));
  change("ce1", a.itemId, "new_topic", "Two claims from one post, less useful.", 0.2);
  change("ce2", a.itemId, "additional_support", "Second claim from the same post.", 0.1);
  change("ce3", b.itemId, "reversal", "Reverses an earlier position on onboarding.", 0.9);
  change("ce4", c.itemId, "repetition", "Says the same thing again.", 0.5);
  change("ce5", c.itemId, "new_topic", "Too old for this brief.", 0.9, "2026-09-01T00:00:00.000Z");
  db.query("INSERT INTO keeps (id, user_ns, content, created_at) VALUES ('keep_b1', 'user:briefuser', '[brief-person] [selected] Ship onboarding in one step.', ?)").run(now());
  db.query("INSERT INTO cards (id, user_id, person_id, goal, data, created_at, updated_at) VALUES ('card_b1', 'briefuser', 'brief-person', 'product_decisions', ?, ?, ?)").run(
    JSON.stringify({ try_it: "Cut one onboarding step today.", success_criterion: "Activation measured on 10 signups." }), "2026-09-27T12:00:00.000Z", "2026-09-27T12:00:00.000Z",
  );
});

describe("morning brief", () => {
  test("one entry per source, lesson-changing news first, repetitions and older news left out", () => {
    const b = buildBrief("briefuser", new Date("2026-09-28T08:00:00.000Z"));
    const p = b.people.find((x) => x.person_id === "brief-person")!;
    expect(p.changes.map((c) => c.summary)).toEqual(["Reverses an earlier position on onboarding.", "Two claims from one post, less useful."]);
    expect(p.skipped_repetitions).toBe(1);
    expect(p.changes[0].relation).toBe("official_document");
  });

  test("a reversal flags the lessons kept from that person and offers one thing to try", () => {
    const p = buildBrief("briefuser", new Date("2026-09-28T08:00:00.000Z")).people.find((x) => x.person_id === "brief-person")!;
    expect(p.lessons_to_recheck.map((k) => k.id)).toEqual(["keep_b1"]);
    expect(p.try_today?.try_it).toBe("Cut one onboarding step today.");
  });

  test("the page says nothing new for quiet people and labels official documents", () => {
    const md = briefMarkdown(buildBrief("briefuser", new Date("2026-09-28T08:00:00.000Z")));
    expect(md).toContain("## Quiet Person");
    expect(md).toMatch(/## Quiet Person[^\n]*\n\nNothing new that matters\./);
    expect(md).toContain("**reversal** · official document");
    expect(md).toContain("> Reverses an earlier position"); // untrusted text is quoted
    expect(md).toContain("**Recheck**");
  });

  test("once written, the next brief only covers what arrives after it, and it runs once a day after the brief hour", async () => {
    process.env.HM_BRIEF_TZ = "UTC";
    process.env.HM_BRIEF_HOUR = "7";
    expect(dueBriefUsers(new Date("2026-09-28T06:00:00.000Z"))).not.toContain("briefuser");
    expect(dueBriefUsers(new Date("2026-09-28T07:30:00.000Z"))).toContain("briefuser");
    const hasGbrain = Bun.spawnSync(["gbrain", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
    if (!hasGbrain) return; // writing the page needs the GBrain CLI
    await runBrief("briefuser", new Date("2026-09-28T07:30:00.000Z"));
    expect(latestBrief("briefuser")?.date).toBe("2026-09-28");
    expect(dueBriefUsers(new Date("2026-09-28T09:00:00.000Z"))).not.toContain("briefuser");
    const next = buildBrief("briefuser", new Date("2026-09-29T08:00:00.000Z"));
    expect(next.quiet).toBe(true);
  });
});

test("agents read the brief through the agent API (read-only token is enough)", async () => {
  const { route } = await import("../src/api/server.ts");
  const tok = app.createAgentToken("briefuser", "test", false);
  const r = await route(new Request("http://127.0.0.1:4747/agent/v1/brief", { headers: { authorization: `Bearer ${tok}` } }));
  expect(r.status).toBe(200);
  const j = await r.json();
  expect(j.markdown).toContain("# Morning brief");
  expect(j.user_id).toBe("briefuser");
  const anon = await route(new Request("http://127.0.0.1:4747/agent/v1/brief"));
  expect(anon.status).toBe(401);
});
