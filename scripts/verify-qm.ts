// End-to-end check of the QM memory-provider integration using QM's OWN client
// code (yc-software/qm: src/mcp/mcp-client.ts + src/memory/mcp-memory-provider.ts).
// Usage: QM_DIR=/path/to/qm HM_URL=http://127.0.0.1:4747 bun run scripts/verify-qm.ts <qm-client.env>
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const qmDir = resolve(process.env.QM_DIR ?? "../qm");
const { createMcpClient } = await import(resolve(qmDir, "src/mcp/mcp-client.ts"));
const { createMcpMemoryProvider } = await import(resolve(qmDir, "src/memory/mcp-memory-provider.ts"));
const creds = Object.fromEntries(
  readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map((l) => l.split("=") as [string, string]),
);
const url = `${process.env.HM_URL ?? "http://127.0.0.1:4747"}/mcp`;
const op = (id: string, secret: string, tool: string, extra: Record<string, string> = {}) => ({
  client: createMcpClient({ url, auth: { mode: "client-credentials", clientId: id, clientSecret: secret } }),
  tool,
  timeoutMs: 30_000,
  ...extra,
});
const provider = createMcpMemoryProvider({
  read: op(creds.HM_QM_RO_CLIENT_ID, creds.HM_QM_RO_CLIENT_SECRET, "hm_recall", { maxCharsArg: "max_chars" }),
  write: op(creds.HM_QM_RW_CLIENT_ID, creds.HM_QM_RW_CLIENT_SECRET, "hm_keep", { idempotencyArg: "idempotency_key", capturedAtArg: "captured_at", sourceArg: "source" }),
});
const t0 = Date.now();
console.log("1. recall (QM personal scope, user alice):");
console.log((await provider.recall("personal:alice", { query: "Garry Tan evaluation evidence", actorId: "U_ALICE", maxChars: 1500 })).slice(0, 1500));
console.log("\n2. keep (explicit capture for alice):");
const note = `Adopted: freeze the eval set before comparing variants (${new Date().toISOString()})`;
await provider.capture("personal:alice", [note], new Date().toISOString(), "U_ALICE", { actorId: "U_ALICE", idempotencyKey: "demo-keep-1", mode: "explicit" });
await provider.capture("personal:alice", [note], new Date().toISOString(), "U_ALICE", { actorId: "U_ALICE", idempotencyKey: "demo-keep-1", mode: "explicit" });
console.log("   stored twice with the same idempotency key");
const alice = await provider.recall("personal:alice", { query: "freeze eval set", actorId: "U_ALICE" });
const bob = await provider.recall("personal:bob", { query: "freeze eval set", actorId: "U_BOB" });
console.log("3. alice sees her kept note:", alice.includes("your kept note"));
console.log("4. bob does NOT see alice's note:", !bob.includes("your kept note"));
let readOnlyBlocked = false;
try {
  await createMcpMemoryProvider({ read: op(creds.HM_QM_RO_CLIENT_ID, creds.HM_QM_RO_CLIENT_SECRET, "hm_recall"), write: op(creds.HM_QM_RO_CLIENT_ID, creds.HM_QM_RO_CLIENT_SECRET, "hm_keep") })
    .capture("personal:alice", ["x"], new Date().toISOString(), "U_ALICE", { actorId: "U_ALICE" });
} catch { readOnlyBlocked = true; }
console.log("5. read-only client cannot write:", readOnlyBlocked);
let badCreds = false;
try { await createMcpMemoryProvider({ read: op(creds.HM_QM_RO_CLIENT_ID, "wrong", "hm_recall") }).recall("personal:x", { query: "x" }); } catch { badCreds = true; }
console.log("6. wrong secret rejected:", badCreds);
console.log(`done in ${Date.now() - t0} ms`);
