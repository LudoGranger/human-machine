import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../src/db.ts";
import { ensurePerson } from "../src/identity/resolve.ts";
import { storeItem } from "../src/pipeline/ingest.ts";
import { exaAdapter, exaResultToItem, isAuthoredBySubject, EXA_EXCLUDED_DOMAINS } from "../src/adapters/exa.ts";
import { upsertEnvLine, validKeyShape, verifyExaKey, writeEnvValue } from "../src/connect.ts";
import { dataDir, resetEnvCache } from "../src/config.ts";
import { AccessRequiredError, type PersonContext, type SourceRow } from "../src/adapters/types.ts";

const person: PersonContext = { id: "exa-person", name: "Ada Test", aliases: ["Ada T. Test"], positions: [], identities: [] };

function source(id: string, lastSuccess: string | null = null): SourceRow {
  const db = getDb();
  ensurePerson("Exa Person");
  db.query(
    "INSERT OR IGNORE INTO sources (id, person_id, adapter, kind, locator, label, mode, status, created_at, last_success_at) VALUES (?, 'exa-person', 'exa', 'blog', ?, 'web', 'poll', 'polling', ?, ?)",
  ).run(id, `loc-${id}`, new Date().toISOString(), lastSuccess);
  return db.query("SELECT * FROM sources WHERE id = ?").get(id) as SourceRow;
}

const ESSAY = "We freeze the test set before running any variant, and we publish negative results even when they hurt.";

let server: ReturnType<typeof Bun.serve>;
const seen: { key: string | null; body: any }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.json();
      seen.push({ key: req.headers.get("x-api-key"), body });
      if (req.headers.get("x-api-key") !== "exa_test_key_1234567890") return new Response('{"error":"invalid key"}', { status: 401 });
      return Response.json({
        requestId: "r1",
        results: [
          { id: "https://ada.example.com/essay", url: "https://ada.example.com/essay", title: "On evaluation", author: "Ada Test", publishedDate: new Date().toISOString(), text: `${ESSAY}\n\n${ESSAY} Again.` },
          { id: "https://paper.example.com/profile", url: "https://paper.example.com/profile", title: "Ada Test profile", author: "Jane Reporter", publishedDate: new Date().toISOString(), text: `Ada Test reportedly said that evals are dead, according to people familiar.` },
        ],
      });
    },
  });
  process.env.HM_EXA_API_BASE = `http://127.0.0.1:${server.port}`;
  process.env.HM_ALLOW_PRIVATE_NETWORK = "1";
});

afterAll(() => {
  server.stop(true);
  delete process.env.HM_EXA_API_BASE;
  delete process.env.HM_ALLOW_PRIVATE_NETWORK;
  process.env.EXA_API_KEY = "";
});

describe("Exa web search source (user's own key)", () => {
  test("without a key the source is not configured and collection asks for access", async () => {
    process.env.EXA_API_KEY = "";
    expect(exaAdapter.configured()).toBe(false);
    expect(exaAdapter.auth.envVars).toEqual(["EXA_API_KEY"]);
    await expect(exaAdapter.collect(source("exa-nokey"), person)).rejects.toBeInstanceOf(AccessRequiredError);
  });

  test("authorship needs an exact name or alias match, never a substring", () => {
    expect(isAuthoredBySubject("Ada Test", person)).toBe(true);
    expect(isAuthoredBySubject("ada t. test", person)).toBe(true);
    expect(isAuthoredBySubject("Jane Reporter, Ada Test", person)).toBe(true);
    expect(isAuthoredBySubject("Ada Testarossa", person)).toBe(false);
    expect(isAuthoredBySubject("Staff, about Ada Test", person)).toBe(false);
    expect(isAuthoredBySubject(null, person)).toBe(false);
  });

  test("a page about the person is reporting and is never analyzed as their statement", () => {
    const src = source("exa-triage");
    const it = exaResultToItem({ id: "p1", url: "https://paper.example.com/x", author: "Jane Reporter", text: "Ada Test reportedly abandons evals, according to two people familiar with the matter." }, person, src);
    expect(it.attribution).toBe("about_subject");
    expect(it.passages.every((p) => p.speakerIsSubject !== true)).toBe(true);
    expect(storeItem(src, it).analyze).toBe(false);
  });

  test("an unparseable date does not throw and is left empty", () => {
    const it = exaResultToItem({ id: "p2", url: "https://a.example.com", publishedDate: "not a date", text: ESSAY }, person, source("exa-date"));
    expect(it.publishedAt).toBeNull();
  });

  test("collect sends the key in a header, excludes covered domains and keeps attribution", async () => {
    process.env.EXA_API_KEY = "exa_test_key_1234567890";
    expect(exaAdapter.configured()).toBe(true);
    const r = await exaAdapter.collect(source("exa-collect"), person);
    const req = seen[seen.length - 1];
    expect(req.key).toBe("exa_test_key_1234567890");
    expect(req.body.excludeDomains).toEqual(EXA_EXCLUDED_DOMAINS);
    expect(JSON.stringify(req.body)).not.toContain("exa_test_key");
    expect(r.items.map((i) => i.attribution)).toEqual(["by_subject", "about_subject"]);
    expect(r.items[0].passages[0].speakerIsSubject).toBe(true);
    // Second poll only asks for newer pages and skips what was already seen.
    const again = await exaAdapter.collect({ ...source("exa-collect"), cursor: r.cursor }, person);
    expect(seen[seen.length - 1].body.startPublishedDate).toBeTruthy();
    expect(again.items).toHaveLength(0);
  });

  test("a rejected key fails verification", async () => {
    await expect(verifyExaKey("exa_wrong_key_1234567890")).rejects.toThrow("401");
    await verifyExaKey("exa_test_key_1234567890");
  });
});

describe("hm connect: storing the user's key", () => {
  test("upsert replaces the template line and keeps other settings", () => {
    const prev = "# GITHUB_TOKEN=\n# EXA_API_KEY=   # comment\nHM_PORT=4747\n";
    const next = upsertEnvLine(prev, "EXA_API_KEY", "abc");
    expect(next).toBe("# GITHUB_TOKEN=\nHM_PORT=4747\nEXA_API_KEY=abc\n");
    expect(upsertEnvLine(next, "EXA_API_KEY", null)).toBe("# GITHUB_TOKEN=\nHM_PORT=4747\n");
  });

  test("the key is written to the data dir .env with mode 600 and read back", async () => {
    process.env.EXA_API_KEY = "";
    delete process.env.EXA_API_KEY;
    const f = writeEnvValue("EXA_API_KEY", "exa_file_key_1234567890");
    expect(f).toBe(join(dataDir(), ".env"));
    expect(statSync(f).mode & 0o777).toBe(0o600);
    expect(readFileSync(f, "utf8")).toContain("EXA_API_KEY=exa_file_key_1234567890");
    expect(exaAdapter.configured()).toBe(true);
    writeEnvValue("EXA_API_KEY", null);
    expect(exaAdapter.configured()).toBe(false);
    expect(existsSync(f)).toBe(true);
    resetEnvCache();
  });

  test("obviously wrong input is not saved as a key", () => {
    expect(validKeyShape("")).toBe(false);
    expect(validKeyShape("my key")).toBe(false);
    expect(validKeyShape("exa_test_key_1234567890")).toBe(true);
  });
});
