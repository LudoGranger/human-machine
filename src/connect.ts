// `hm connect <service>`: store a user's own API key in <dataDir>/.env
// (mode 600), verify it against the service, and re-run discovery so people
// already being followed pick up the new source. Keys are read from stdin, never
// from argv (shell history) and never logged.
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataDir, resetEnvCache } from "./config.ts";
import { getDb } from "./db.ts";
import { enqueue } from "./jobs/queue.ts";
import { safeFetch } from "./net/safeFetch.ts";
import { exaApiBase } from "./adapters/exa.ts";

export const CONNECTABLE: Record<string, { envVar: string; signup: string }> = {
  exa: { envVar: "EXA_API_KEY", signup: "https://dashboard.exa.ai/api-keys" },
  gbrain: { envVar: "GBRAIN_REMOTE_TOKEN", signup: "gbrain.io → Settings → Use it in your agent → Access token" },
};

export const DEFAULT_GBRAIN_URL = "https://gbrain.io/mcp";

// Replace (or append) NAME=value in a dotenv file, keeping every other line.
export function upsertEnvLine(content: string, name: string, value: string | null): string {
  const lines = content.split("\n").filter((l) => !new RegExp(`^\\s*#?\\s*${name}\\s*=`).test(l));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  if (value !== null) lines.push(`${name}=${value}`);
  return lines.join("\n") + "\n";
}

export function writeEnvValue(name: string, value: string | null): string {
  const path = join(dataDir(), ".env");
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "";
  writeFileSync(path, upsertEnvLine(prev, name, value), { mode: 0o600 });
  chmodSync(path, 0o600);
  resetEnvCache();
  return path;
}

export async function verifyExaKey(key: string): Promise<void> {
  // Smallest possible request: one result, no page contents.
  await safeFetch(`${exaApiBase()}/search`, {
    method: "POST",
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query: "Human Machine connection check", numResults: 1 }),
    timeoutMs: 15_000,
  });
}

// Queue discovery for every verified person so the new source is added to them.
export function rediscoverAll(): number {
  const people = getDb().query("SELECT id FROM persons WHERE identity_status = 'verified'").all() as { id: string }[];
  for (const p of people) enqueue("discover", { personId: p.id }, { key: `discover:${p.id}:connect:${Date.now()}` });
  return people.length;
}

export function validKeyShape(key: string): boolean {
  return /^[A-Za-z0-9_\-.]{16,200}$/.test(key);
}

// --- Your own hosted GBrain workspace ---------------------------------------
// Checks the workspace with the exact settings before saving them: the MCP
// tools the backend needs are listed, and a page is written and read back.
export async function verifyGbrainWorkspace(url: string, token: string): Promise<{ tools: string[]; slug: string }> {
  const { remoteListTools, putPage, getPage, fullSlug } = await import("./gbrain/client.ts");
  const prev = { url: process.env.GBRAIN_REMOTE_URL, token: process.env.GBRAIN_REMOTE_TOKEN, backend: process.env.HM_GBRAIN_PUBLIC_BACKEND };
  process.env.GBRAIN_REMOTE_URL = url;
  process.env.GBRAIN_REMOTE_TOKEN = token;
  process.env.HM_GBRAIN_PUBLIC_BACKEND = "remote";
  try {
    const tools = await remoteListTools();
    const missing = ["put_page", "get_page", "search"].filter((t) => !tools.includes(t));
    if (missing.length) throw new Error(`the workspace does not offer ${missing.join(", ")}`);
    const marker = `Human Machine connection check ${new Date().toISOString()}`;
    await putPage("public", "connection-check", `# Connection check\n\n${marker}\n`);
    const back = await getPage("public", "connection-check");
    if (!back?.includes(marker)) throw new Error("the test page was written but could not be read back");
    return { tools, slug: fullSlug("public", "connection-check") };
  } finally {
    for (const [k, v] of [["GBRAIN_REMOTE_URL", prev.url], ["GBRAIN_REMOTE_TOKEN", prev.token], ["HM_GBRAIN_PUBLIC_BACKEND", prev.backend]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

// --- Your own QM deployment ------------------------------------------------
// QM calls the backend from its servers, so the address must be public HTTPS.
export function qmReachableUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(host) || host.endsWith(".local"))
    throw new Error(`${host} is only reachable from this computer; QM needs the public HTTPS address of your Human Machine backend (see docs/DEPLOY.md)`);
  if (u.protocol !== "https:") throw new Error("use an https:// address; QM sends client secrets to it");
  return u.origin;
}

// What the user adds to their QM deployment directory (the one `qm init` created).
export function qmSetupInstructions(baseUrl: string, credsFile: string, providerConfig: unknown): string {
  const names = ["HM_QM_RO_CLIENT_ID", "HM_QM_RO_CLIENT_SECRET", "HM_QM_RW_CLIENT_ID", "HM_QM_RW_CLIENT_SECRET"];
  return [
    `Connect your QM deployment to Human Machine at ${baseUrl}`,
    "",
    `1. In your QM deployment directory, append the four client credentials to .env (private, never committed):`,
    `     cat ${credsFile} >> .env`,
    "",
    "2. In qm.config.jsonc, add under env.core:",
    `     "MEMORY_PROVIDER_CONFIG": ${JSON.stringify(JSON.stringify(providerConfig))}`,
    "   and add under secretEnv.core, so QM's core receives the credentials:",
    ...names.map((n) => `     "${n}": "${n}",`),
    "",
    "3. Validate and roll out:",
    "     npm exec qm -- check      # the four HM_QM_* names now appear under required secrets",
    "     npm exec qm -- secrets push",
    "     npm exec qm -- up",
    "",
    "4. Prove it in QM web: ask a question about someone you follow in Human Machine (recall),",
    '   then say "remember: <a lesson>" (Keep), and in a new chat ask what you asked it to remember:',
    "   the answer comes back through hm_recall, which returns your own kept notes (private to you in QM).",
  ].join("\n");
}
