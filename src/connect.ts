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
};

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
