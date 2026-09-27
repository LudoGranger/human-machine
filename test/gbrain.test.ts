// Real GBrain integration (skipped when the gbrain CLI is not installed).
import { describe, expect, test } from "bun:test";
import { putPage, searchPages, getPage } from "../src/gbrain/client.ts";

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
});
