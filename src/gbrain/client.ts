// GBrain integration. Three layers are kept in separate brains (separate
// GBRAIN_HOME directories → separate PGLite databases), because source tags are
// not access controls:
//   public           — public person evidence, claims and attributed rules
//   app              — application-generated interpretations and adaptations
//   private:<userId> — one brain per user: goals, tasks, feedback, outcomes
// The public layer may instead live in a hosted GBrain workspace (remote MCP
// over HTTPS with a bearer token) when GBRAIN_REMOTE_URL/GBRAIN_REMOTE_TOKEN are
// set. App and private layers never leave this computer.
//
// Commands used are the documented CLI (`gbrain init/put/get/search`) and MCP
// operations (`put_page`, `get_page`, `search`) of GBrain 0.59.x.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { config, dataDir, env } from "../config.ts";
import { getDb, now } from "../db.ts";
import { sha256 } from "../util.ts";

export type Layer = "public" | "app" | `private:${string}`;

export interface SearchHit {
  slug: string;
  title: string;
  chunk_text: string;
  score: number;
}

export interface LayerStatus {
  layer: string;
  backend: "local" | "remote";
  location: string;
  ok: boolean | null;
  lastOkAt: string | null;
  lastError: string | null;
  pagesWritten: number;
}

const status = new Map<string, LayerStatus>();
const locks = new Map<string, Promise<unknown>>();

function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => undefined));
  return next;
}

export function remoteConfigured(): boolean {
  return !!(env("GBRAIN_REMOTE_URL") && env("GBRAIN_REMOTE_TOKEN"));
}

function backendFor(layer: Layer): "local" | "remote" {
  if (layer === "public" && remoteConfigured() && env("HM_GBRAIN_PUBLIC_BACKEND") !== "local") return "remote";
  return "local";
}

export function layerHome(layer: Layer): string {
  const safe = layer.replace(/[^a-z0-9:_-]/gi, "").replace(":", "-");
  return join(dataDir(), "gbrain", safe);
}

function mark(layer: Layer, ok: boolean, err?: string) {
  const s = status.get(layer) ?? {
    layer,
    backend: backendFor(layer),
    location: backendFor(layer) === "remote" ? new URL(env("GBRAIN_REMOTE_URL")!).host : layerHome(layer),
    ok: null,
    lastOkAt: null,
    lastError: null,
    pagesWritten: 0,
  };
  s.ok = ok;
  if (ok) s.lastOkAt = now();
  else s.lastError = (err ?? "unknown error").slice(0, 300);
  status.set(layer, s);
  getDb()
    .query("INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
    .run(`gbrain_status:${layer}`, JSON.stringify(s), now());
}

export function layerStatuses(): LayerStatus[] {
  const rows = getDb().query("SELECT v FROM kv WHERE k LIKE 'gbrain_status:%'").all() as { v: string }[];
  const out = rows.map((r) => JSON.parse(r.v) as LayerStatus);
  for (const o of out) {
    o.pagesWritten = (getDb().query("SELECT COUNT(*) n FROM gbrain_writes WHERE layer = ?").get(o.layer) as { n: number }).n;
  }
  return out;
}

// --- Local CLI backend ------------------------------------------------------
async function run(layer: Layer, args: string[], stdin?: string, timeoutMs = 90_000): Promise<string> {
  const home = layerHome(layer);
  const proc = Bun.spawn([config.gbrainBin(), ...args], {
    env: {
      ...process.env,
      GBRAIN_HOME: home,
      // The app brain is not a personal agent brain: no ambient capture, no
      // update checks, and no provider keys are forwarded to GBrain.
      ANTHROPIC_API_KEY: "",
      OPENAI_API_KEY: "",
      VOYAGE_API_KEY: "",
      GBRAIN_NO_UPDATE_CHECK: "1",
      NO_COLOR: "1",
    },
    stdin: stdin !== undefined ? new TextEncoder().encode(stdin) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (code !== 0) throw new Error(`gbrain ${args[0]} exited ${code}: ${(err || out).trim().split("\n").slice(-3).join(" | ").slice(0, 400)}`);
  return out;
}

export async function ensureLocalBrain(layer: Layer): Promise<void> {
  const home = layerHome(layer);
  if (existsSync(join(home, ".gbrain", "config.json"))) return;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  await run(layer, ["init", "--pglite", "--no-embedding", "--db-only"], undefined, 180_000);
}

// --- Remote MCP backend (hosted GBrain) --------------------------------------
let mcpSession: string | null = null;
let rpcId = 1;

async function mcpRpc(method: string, params: unknown): Promise<any> {
  const url = env("GBRAIN_REMOTE_URL")!;
  const headers: Record<string, string> = {
    authorization: `Bearer ${env("GBRAIN_REMOTE_TOKEN")}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (mcpSession) headers["mcp-session-id"] = mcpSession;
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }) });
  const sid = res.headers.get("mcp-session-id");
  if (sid) mcpSession = sid;
  const body = await res.text();
  if (!res.ok) throw new Error(`remote GBrain HTTP ${res.status}: ${body.slice(0, 200)}`);
  let msg: any;
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = body.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    msg = JSON.parse(data[data.length - 1] ?? "{}");
  } else msg = JSON.parse(body);
  if (msg.error) throw new Error(`remote GBrain ${method}: ${msg.error.message ?? JSON.stringify(msg.error)}`);
  return msg.result;
}

async function mcpInit() {
  if (mcpSession) return;
  await mcpRpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "human-machine", version: "0.1.0" } });
  try {
    await fetch(env("GBRAIN_REMOTE_URL")!, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env("GBRAIN_REMOTE_TOKEN")}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
  } catch {
    /* notification is best effort */
  }
}

async function mcpTool(name: string, args: Record<string, unknown>): Promise<any> {
  await mcpInit();
  const r = await mcpRpc("tools/call", { name, arguments: args });
  if (r?.isError) throw new Error(`remote GBrain ${name}: ${JSON.stringify(r.content).slice(0, 300)}`);
  const t = (r?.content ?? []).find((c: any) => c.type === "text")?.text;
  try {
    return t ? JSON.parse(t) : r?.structuredContent ?? r;
  } catch {
    return t;
  }
}

export async function remoteTool(name: string, args: Record<string, unknown>): Promise<any> {
  if (!remoteConfigured()) throw new Error("GBRAIN_REMOTE_URL / GBRAIN_REMOTE_TOKEN not configured");
  return mcpTool(name, args);
}

export async function remoteListTools(): Promise<string[]> {
  await mcpInit();
  const r = await mcpRpc("tools/list", {});
  return (r?.tools ?? []).map((t: any) => t.name);
}

// --- Public API ---------------------------------------------------------------
const PREFIX = () => env("HM_GBRAIN_SLUG_PREFIX") || "hm";

export function fullSlug(layer: Layer, slug: string): string {
  // Remote (hosted workspace) pages live under a dedicated prefix.
  return backendFor(layer) === "remote" ? `${PREFIX()}/${slug}` : slug;
}

export async function putPage(layer: Layer, slug: string, markdown: string): Promise<"written" | "unchanged"> {
  // Postgres/PGLite text cannot hold NUL or lone surrogates.
  markdown = markdown.toWellFormed().replace(/\u0000/g, "");
  const hash = sha256(markdown);
  const prev = getDb().query("SELECT content_hash FROM gbrain_writes WHERE layer = ? AND slug = ?").get(layer, slug) as { content_hash: string } | null;
  if (prev?.content_hash === hash) return "unchanged";
  const key = backendFor(layer) === "remote" ? "remote" : layerHome(layer);
  await withLock(key, async () => {
    try {
      if (backendFor(layer) === "remote") {
        await mcpTool("put_page", { slug: fullSlug(layer, slug), content: markdown, force: true, request_id: randomUUID() });
      } else {
        await ensureLocalBrain(layer);
        await run(layer, ["put", slug, "--force", "--request-id", randomUUID()], markdown);
      }
      mark(layer, true);
    } catch (err) {
      mark(layer, false, (err as Error).message);
      throw err;
    }
  });
  getDb()
    .query("INSERT INTO gbrain_writes (layer, slug, content_hash, written_at) VALUES (?, ?, ?, ?) ON CONFLICT(layer, slug) DO UPDATE SET content_hash = excluded.content_hash, written_at = excluded.written_at")
    .run(layer, slug, hash, now());
  return "written";
}

export async function searchPages(layer: Layer, query: string, limit = 10): Promise<SearchHit[]> {
  const key = backendFor(layer) === "remote" ? "remote" : layerHome(layer);
  return withLock(key, async () => {
    try {
      let hits: any[];
      if (backendFor(layer) === "remote") {
        const r = await mcpTool("search", { query, limit });
        hits = Array.isArray(r) ? r : r?.results ?? [];
        hits = hits.filter((h) => String(h.slug).startsWith(PREFIX() + "/")).map((h) => ({ ...h, slug: String(h.slug).slice(PREFIX().length + 1) }));
      } else {
        await ensureLocalBrain(layer);
        const out = await run(layer, ["search", query, "--json", "--limit", String(limit)]);
        hits = JSON.parse(out.slice(out.indexOf("[")));
      }
      mark(layer, true);
      return hits.map((h) => ({ slug: h.slug, title: h.title, chunk_text: h.chunk_text, score: h.score }));
    } catch (err) {
      mark(layer, false, (err as Error).message);
      throw err;
    }
  });
}

export async function getPage(layer: Layer, slug: string): Promise<string | null> {
  const key = backendFor(layer) === "remote" ? "remote" : layerHome(layer);
  return withLock(key, async () => {
    try {
      let out: string;
      if (backendFor(layer) === "remote") {
        const r = await mcpTool("get_page", { slug: fullSlug(layer, slug), include_content: true });
        out = typeof r === "string" ? r : r?.content ?? r?.compiled_truth ?? JSON.stringify(r);
      } else {
        await ensureLocalBrain(layer);
        out = await run(layer, ["get", slug]);
      }
      mark(layer, true);
      return out;
    } catch (err) {
      if (/not found|no page/i.test((err as Error).message)) return null;
      mark(layer, false, (err as Error).message);
      throw err;
    }
  });
}

// Untrusted text is rendered as blockquotes so it cannot form frontmatter,
// headings, fenced "## Facts" blocks, or instructions at page level.
export function quoteUntrusted(s: string): string {
  return s
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => "> " + l.replace(/^(\s*)(---|```|~~~|<!--)/, "$1\\$2"))
    .join("\n");
}

export function yamlStr(s: string | null | undefined): string {
  if (s === null || s === undefined) return "null";
  // Lone surrogates / control chars become \uXXXX escapes that YAML rejects.
  const clean = String(s).toWellFormed().replace(/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029]/g, " ");
  return JSON.stringify(clean);
}
