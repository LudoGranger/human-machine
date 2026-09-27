#!/usr/bin/env bun
// hm — Human Machine command line.
import { existsSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { dataDir, config, APP_VERSION } from "./config.ts";
import { getDb, kvGet, kvSet, now } from "./db.ts";
import * as app from "./app.ts";
import { runWorker } from "./jobs/worker.ts";
import { serve } from "./api/server.ts";
import { runMcp } from "./mcp/server.ts";
import { ensureLocalBrain, layerStatuses, remoteConfigured, remoteListTools } from "./gbrain/client.ts";
import { evidenceQuery } from "./pipeline/brain.ts";
import { exportSkill, installSkill, setSkillStatus } from "./export/skill.ts";
import { runExperiment } from "./eval/experiment.ts";
import { generateCards } from "./pipeline/cards.ts";
import { sleep } from "./util.ts";

let PREV_HEARTBEAT: string | null = null;

const ENV_TEMPLATE = `# Human Machine local configuration (mode 600). Never commit this file.
# Analysis model — choose one:
# ANTHROPIC_API_KEY=
# HM_LLM_PROVIDER=claude-cli        # use the locally installed Claude Code CLI (your plan's usage)
# HM_LLM_DAILY_BUDGET_USD=2
# Optional source credentials:
# X_BEARER_TOKEN=                   # X API (paid) — enables the X adapter
# GITHUB_TOKEN=                     # optional, higher GitHub REST limits
# GOOGLE_BOOKS_API_KEY=
# Optional hosted GBrain workspace for the PUBLIC evidence layer:
# GBRAIN_REMOTE_URL=
# GBRAIN_REMOTE_TOKEN=
`;

function heartbeat() {
  PREV_HEARTBEAT = kvGet("worker_heartbeat");
  kvSet("worker_heartbeat", `${now()}|${process.pid}`);
  return setInterval(() => kvSet("worker_heartbeat", `${now()}|${process.pid}`), 15_000);
}

async function waitForPerson(personId: string, timeoutS = 900) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const p = getDb().query("SELECT research_status FROM persons WHERE id = ?").get(personId) as any;
    const pending = (getDb().query("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running') AND json_extract(payload, '$.personId') = ?").get(personId) as any).n;
    process.stdout.write(`\r${p?.research_status ?? "?"} · ${pending} pending jobs   `);
    if (pending === 0 && !["resolving", "not_started"].includes(p?.research_status)) break;
    await sleep(3000);
  }
  process.stdout.write("\n");
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const flag = (f: string) => args.includes(f);
  const pos = args.filter((a) => !a.startsWith("--"));
  switch (cmd) {
    case "init": {
      const dir = dataDir();
      const envPath = join(dir, ".env");
      if (!existsSync(envPath)) {
        writeFileSync(envPath, ENV_TEMPLATE, { mode: 0o600 });
        console.log(`created ${envPath} (mode 600)`);
      }
      getDb();
      app.ensureUser();
      app.seedCatalog();
      for (const layer of ["public", "app", "private:local"] as const) {
        if (layer === "public" && remoteConfigured()) continue;
        await ensureLocalBrain(layer);
        console.log(`GBrain ${layer} brain ready`);
      }
      const claude = Bun.which("claude");
      console.log(`data dir: ${dir}`);
      console.log(`analysis model: ${config.llmProvider()}${config.llmProvider() === "none" ? (claude ? " — Claude Code CLI found; set HM_LLM_PROVIDER=claude-cli in .env to use it" : " — set ANTHROPIC_API_KEY in .env") : ""}`);
      break;
    }
    case "serve": {
      getDb();
      app.ensureUser();
      app.seedCatalog();
      const s = serve();
      console.log(`Human Machine ${APP_VERSION} on http://${s.hostname}:${s.port}`);
      if (!flag("--no-worker")) {
        heartbeat();
        await runWorker({ lastHeartbeat: PREV_HEARTBEAT });
      }
      break;
    }
    case "worker":
      getDb();
      heartbeat();
      await runWorker({ once: flag("--once"), lastHeartbeat: PREV_HEARTBEAT });
      break;
    case "research": {
      const name = pos.join(" ");
      if (!name) throw new Error("usage: hm research <name> [--wait]");
      app.ensureUser();
      const id = app.startResearch(name);
      console.log(`research started for ${id}`);
      if (flag("--wait")) {
        const ctl = new AbortController();
        heartbeat();
        const w = runWorker({ signal: ctl.signal, lastHeartbeat: PREV_HEARTBEAT });
        await waitForPerson(id);
        ctl.abort();
        await w;
        console.log(JSON.stringify(app.personDetail(id)?.sources.map((s: any) => ({ label: s.label, status: s.display_status, items: s.item_count, error: s.last_error })), null, 1));
      }
      break;
    }
    case "follow": {
      const [personId, goal, ...note] = pos;
      app.ensureUser();
      app.follow("local", personId, goal as any, note.join(" ") || null);
      console.log(`following ${personId} for ${goal}`);
      break;
    }
    case "cards": {
      console.log(JSON.stringify(await generateCards("local", pos[0]), null, 1));
      break;
    }
    case "agent-token": {
      app.ensureUser();
      const token = app.createAgentToken("local", pos[0] ?? "desktop agent");
      const f = process.env.HM_TOKEN_FILE || join(homedir(), ".human-machine", "agent-token");
      writeFileSync(f, token, { mode: 0o600 });
      chmodSync(f, 0o600);
      console.log(`read-only agent token written to ${f} (mode 600)`);
      break;
    }
    case "export-skill": {
      const r = await exportSkill("local", pos[0]);
      console.log(`skill ${r.manifest.name} v${r.version}${r.unchanged ? " (unchanged)" : ""} at ${r.path}`);
      const target = args[args.indexOf("--install") + 1];
      if (flag("--install")) {
        const root = target === "user" ? join(homedir(), ".claude", "skills") : join(target, ".claude", "skills");
        console.log(`installed to ${installSkill(r.path, root)}`);
        setSkillStatus("local", r.id, "retained", `installed to ${root}`);
      }
      break;
    }
    case "eval": {
      const r = await runExperiment("local", pos[0]);
      console.log(JSON.stringify(r, null, 1));
      break;
    }
    case "brain-search": {
      console.log(JSON.stringify(await evidenceQuery(pos[0], pos.slice(1).join(" ")), null, 1));
      break;
    }
    case "status":
      console.log(JSON.stringify(app.systemStatus(), null, 1));
      break;
    case "doctor": {
      const checks: Record<string, string> = {};
      checks.bun = Bun.version;
      const gb = Bun.spawnSync([config.gbrainBin(), "--version"]);
      checks.gbrain = gb.exitCode === 0 ? gb.stdout.toString().trim() : "NOT FOUND — see README";
      checks.claude_cli = Bun.which("claude") ? "found" : "not found";
      checks.llm_provider = config.llmProvider();
      checks.x_api = config.xBearer() ? "token set" : "not configured (X sources: Access required)";
      checks.gbrain_remote = remoteConfigured() ? "configured" : "not configured (local brains)";
      if (remoteConfigured()) {
        try {
          checks.gbrain_remote_tools = (await remoteListTools()).filter((t) => ["put_page", "get_page", "search"].includes(t)).join(",") || "required tools missing";
        } catch (e) {
          checks.gbrain_remote_tools = `FAILED: ${(e as Error).message.slice(0, 120)}`;
        }
      }
      checks.gbrain_layers = JSON.stringify(layerStatuses().map((l) => `${l.layer}:${l.backend}:${l.ok}`));
      console.log(JSON.stringify(checks, null, 1));
      break;
    }
    case "mcp":
      await runMcp();
      break;
    case "collab": {
      const { collabPublish, collabInbox, collabReply } = await import("./collab.ts");
      if (pos[0] === "publish") console.log("published:", (await collabPublish()).join(", "));
      else if (pos[0] === "inbox") console.log(JSON.stringify(await collabInbox(), null, 1));
      else if (pos[0] === "reply") console.log("wrote", await collabReply(pos[1], pos.slice(2).join(" ")));
      else console.log("usage: hm collab publish | inbox | reply <topic> <text>");
      break;
    }
    default:
      console.log(`hm ${APP_VERSION}
  init                       create data dir, config template, GBrain brains, catalog
  serve [--no-worker]        backend API on http://${config.host()}:${config.port()} (+ worker)
  worker [--once]            run ingestion/analysis jobs
  research <name> [--wait]   resolve identity, discover sources, collect, analyze
  follow <person-id> <goal>  goals: building_with_ai product_decisions research communication market_policy
  cards <person-id>          generate learning cards now
  agent-token                create a read-only token for desktop agents
  export-skill <person-id> [--install user|<project-dir>]
  eval <person-id>           run the 3-arm workflow experiment
  brain-search <person-id> <query>
  collab publish|inbox|reply  share API contract/status with other agents via the hosted GBrain
  status | doctor | mcp`);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
