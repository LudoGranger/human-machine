// Real GBrain integration (skipped when the gbrain CLI is not installed).
import { describe, expect, test } from "bun:test";
import { putPage, searchPages, getPage } from "../src/gbrain/client.ts";
import * as app from "../src/app.ts";
import { route } from "../src/api/server.ts";

const hasGbrain = Bun.spawnSync(["gbrain", "--version"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;

describe.skipIf(!hasGbrain)("GBrain (real CLI, isolated temp brains)", () => {
  test("write → keyword search → read round trip on the public layer", async () => {
    await putPage("public", "evidence/ada-test/abc123", `---\ntitle: "Ada Test — frozen eval sets"\ntype: source\n---\n\n> We freeze the zanzibarquux test set before running variants.\n`);
    const hits = await searchPages("public", "zanzibarquux", 5);
    expect(hits.some((h) => h.slug === "evidence/ada-test/abc123")).toBe(true);
    expect(await getPage("public", "evidence/ada-test/abc123")).toContain("zanzibarquux");
  }, 120_000);

  test("one user's private brain is not searchable from another user's brain", async () => {
    await putPage("private:alice", "goals/ada-test", `---\ntitle: "alice goal"\ntype: note\n---\n\nqwertyplonk secret project\n`);
    expect((await searchPages("private:alice", "qwertyplonk", 5)).length).toBeGreaterThan(0);
    expect((await searchPages("private:bob", "qwertyplonk", 5)).length).toBe(0);
    expect((await searchPages("public", "qwertyplonk", 5)).length).toBe(0);
  }, 180_000);

  test("desktop Keep: read-only token refused; keep token stores privately, idempotently, with read-back", async () => {
    app.ensureUser("alice");
    app.ensureUser("bob");
    const ro = app.createAgentToken("alice", "ro");
    const rw = app.createAgentToken("alice", "rw", true);
    const bobRw = app.createAgentToken("bob", "rw", true);
    const post = (tok: string, body: unknown) =>
      route(new Request("http://127.0.0.1:4747/agent/v1/keep", { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await post(ro, { content: "x" })).status).toBe(403);
    const first = await (await post(rw, { content: "Adopted: freeze eval sets", person: "garry-tan", status: "tried", idempotency_key: "k1" })).json();
    expect(first.kept).toBe(true);
    expect(first.readback).toBe(true);
    const again = await (await post(rw, { content: "Adopted: freeze eval sets", person: "garry-tan", status: "tried", idempotency_key: "k1" })).json();
    expect(again.duplicate).toBe(true);
    const list = (tok: string) => route(new Request("http://127.0.0.1:4747/agent/v1/keeps?q=freeze", { headers: { authorization: `Bearer ${tok}` } })).then((r) => r.json());
    expect((await list(rw)).length).toBe(1);
    expect((await list(bobRw)).length).toBe(0);
  }, 180_000);
});
