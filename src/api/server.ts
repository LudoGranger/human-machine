// HTTP API server (backend only): app API for the local user + read-only agent
// API (bearer). The web frontend is a separate project (see COLLABORATION.md)
// and may call this API from origins listed in HM_CORS_ORIGINS.
// Binds to 127.0.0.1 by default. When bound elsewhere (server deployment),
// the app API requires HM_UI_TOKEN; the agent API always requires a token.
import { APP_VERSION, config, env } from "../config.ts";
import * as app from "../app.ts";
import { setCardStatus, generateCards } from "../pipeline/cards.ts";
import { evidenceQuery } from "../pipeline/brain.ts";
import { cancel } from "../jobs/queue.ts";
import { GOALS } from "../schema.ts";
import { exportSkill, listSkillVersions, rollbackSkill } from "../export/skill.ts";
import { listExperiments } from "../eval/experiment.ts";
import { getDb } from "../db.ts";

const LOCAL_USER = "local";

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d, null, 0), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const err = (status: number, message: string) => json({ error: message }, status);

function uiAuthorized(req: Request): boolean {
  const host = config.host();
  if (host === "127.0.0.1" || host === "localhost" || host === "::1") return true;
  const t = env("HM_UI_TOKEN");
  if (!t) return false; // refuse to expose the app API without a token
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(/;\s*/).includes(`hm_ui=${t}`) || req.headers.get("authorization") === `Bearer ${t}`;
}

function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function body(req: Request): Promise<any> {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

export async function route(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  const m = (re: RegExp) => path.match(re);

  // ---- Agent API (read-only, bearer token → user) -------------------------
  if (path.startsWith("/agent/v1/")) {
    if (req.method !== "GET") return err(405, "read-only API");
    const userId = app.userForToken(bearer(req));
    if (!userId) return err(401, "missing or invalid agent token");
    const person = url.searchParams.get("person") ?? "";
    if (path === "/agent/v1/context") {
      const ctx = await app.agentContext(userId, person, url.searchParams.get("goal") ?? undefined);
      return ctx ? json(ctx) : err(404, "unknown person");
    }
    if (path === "/agent/v1/changes") {
      const since = url.searchParams.get("since") ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
      if (isNaN(Date.parse(since))) return err(400, "since must be an ISO date");
      return json({ generated_at: new Date().toISOString(), person, since, changes: app.recentChanges(person, new Date(since).toISOString()) });
    }
    const ev = m(/^\/agent\/v1\/evidence\/([a-f0-9]{16})$/);
    if (ev) {
      const r = app.evidenceById(person || null, ev[1]);
      return r ? json(r) : err(404, "not found");
    }
    if (path === "/agent/v1/persons") return json(app.listPersons().map((p: any) => ({ id: p.id, name: p.name, research_status: p.research_status })));
    return err(404, "unknown endpoint");
  }

  if (!uiAuthorized(req)) {
    if (path === "/login" && url.searchParams.get("token") === env("HM_UI_TOKEN"))
      return new Response(null, { status: 302, headers: { location: "/", "set-cookie": `hm_ui=${env("HM_UI_TOKEN")}; HttpOnly; SameSite=Strict; Path=/` } });
    return err(401, "API token required (HM_UI_TOKEN)");
  }

  // ---- App API ----------------------------------------------------------------
  if (path.startsWith("/api/")) {
    // CSRF: mutating requests must be same-origin JSON.
    if (req.method !== "GET" && !(req.headers.get("content-type") ?? "").includes("application/json")) return err(415, "JSON required");
    try {
      if (path === "/api/status") return json({ ...app.systemStatus(), goals: GOALS });
      if (path === "/api/persons" && req.method === "GET") return json(app.listPersons());
      if (path === "/api/persons" && req.method === "POST") {
        const b = await body(req);
        const name = String(b.name ?? "").trim();
        if (name.length < 2 || name.length > 120) return err(400, "name required");
        return json({ id: app.startResearch(name) });
      }
      let mm = m(/^\/api\/persons\/([a-z0-9-]+)$/);
      if (mm) {
        const d = app.personDetail(mm[1]);
        if (!d) return err(404, "unknown person");
        const f = getDb().query("SELECT goal, goal_note FROM follows WHERE user_id = ? AND person_id = ?").get(LOCAL_USER, mm[1]);
        return json({ ...d, follow: f });
      }
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/research$/)) && req.method === "POST") {
        const p = getDb().query("SELECT name FROM persons WHERE id = ?").get(mm[1]) as any;
        if (!p) return err(404, "unknown person");
        return json({ id: app.startResearch(p.name) });
      }
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/clarify$/)) && req.method === "POST") {
        app.clarifyIdentity(mm[1], String((await body(req)).qid));
        return json({ ok: true });
      }
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/timeline$/))) return json(app.timeline(mm[1]));
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/profile$/))) return json(app.profile(mm[1]));
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/follow$/)) && req.method === "POST") {
        const b = await body(req);
        app.follow(LOCAL_USER, mm[1], b.goal, b.note ?? null);
        return json({ ok: true });
      }
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/material$/)) && req.method === "POST") {
        const b = await body(req);
        if (!b.rightsNote) return err(400, "State why you may use this material (rightsNote)");
        if (!["by_subject", "about_subject", "interview"].includes(b.attribution)) return err(400, "attribution required");
        return json(await app.addMaterial(mm[1], b));
      }
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/brain$/))) {
        const q = url.searchParams.get("q") ?? "";
        if (!q) return err(400, "q required");
        return json({ query: q, hits: await evidenceQuery(mm[1], q, 8) });
      }
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/cards$/)) && req.method === "POST") return json(await generateCards(LOCAL_USER, mm[1]));
      if (path === "/api/cards") return json(app.cardsFor(LOCAL_USER, url.searchParams.get("person") ?? undefined));
      if ((mm = m(/^\/api\/cards\/([a-z0-9_]+)\/status$/)) && req.method === "POST") {
        const b = await body(req);
        setCardStatus(LOCAL_USER, mm[1], b.status, b.note ?? null);
        return json({ ok: true });
      }
      if ((mm = m(/^\/api\/jobs\/(\d+)\/cancel$/)) && req.method === "POST") return json({ cancelled: cancel(Number(mm[1])) });
      if (path === "/api/experiments") return json(listExperiments(LOCAL_USER));
      if ((mm = m(/^\/api\/persons\/([a-z0-9-]+)\/skill$/))) {
        if (req.method === "POST") return json(await exportSkill(LOCAL_USER, mm[1]));
        return json(listSkillVersions(LOCAL_USER, mm[1]));
      }
      if ((mm = m(/^\/api\/skills\/([a-z0-9_]+)\/rollback$/)) && req.method === "POST") return json(rollbackSkill(LOCAL_USER, mm[1]));
      if (path === "/api/agent-tokens" && req.method === "POST") {
        const b = await body(req);
        return json({ token: app.createAgentToken(LOCAL_USER, String(b.label ?? "desktop agent").slice(0, 60)), note: "Shown once. Stored hashed." });
      }
      return err(404, "unknown endpoint");
    } catch (e) {
      return err(500, (e as Error).message.slice(0, 300));
    }
  }

  if (path === "/" || path === "/api") {
    return json({ name: "human-machine", version: APP_VERSION, api: "/api/*", agent_api: "/agent/v1/*", contract: "docs/API.md" });
  }
  return err(404, "not found");
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = (env("HM_CORS_ORIGINS") ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-credentials": "true",
    vary: "origin",
  };
}

export function serve() {
  const server = Bun.serve({
    hostname: config.host(),
    port: config.port(),
    idleTimeout: 60,
    fetch: (req) => {
      const cors = corsHeaders(req);
      if (req.method === "OPTIONS") return new Response(null, { status: cors["access-control-allow-origin"] ? 204 : 403, headers: cors });
      return route(req).then((r) => {
        for (const [k, v] of Object.entries(cors)) r.headers.set(k, v);
        r.headers.set("content-security-policy", "default-src 'none'; frame-ancestors 'none'");
        r.headers.set("referrer-policy", "no-referrer");
        return r;
      });
    },
  });
  return server;
}
