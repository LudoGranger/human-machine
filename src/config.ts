// Runtime configuration. Secrets are read from the environment or from
// <dataDir>/.env (created by `hm init`, mode 0600). Nothing here is ever sent
// to the browser: the API exposes only booleans ("configured: yes/no").
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const APP_VERSION = "0.1.0";

export function dataDir(): string {
  const dir = resolve(process.env.HM_DATA_DIR || join(homedir(), ".human-machine"));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  // GBrain rejects content roots that traverse symlinks (e.g. macOS /var → /private/var).
  return realpathSync(dir);
}

function loadDotEnv(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

let cached: Record<string, string> | null = null;

export function env(name: string): string | undefined {
  if (!cached) cached = { ...loadDotEnv(join(dataDir(), ".env")), ...loadDotEnv(resolve(".env")) };
  const v = process.env[name] ?? cached[name];
  return v && v.trim() ? v.trim() : undefined;
}

export function resetEnvCache() {
  cached = null;
}

export const config = {
  port: () => Number(env("HM_PORT") || 4747),
  host: () => env("HM_HOST") || "127.0.0.1",
  userAgent: () =>
    env("HM_USER_AGENT") || `HumanMachine/${APP_VERSION} (+https://github.com/LudoGranger/human-machine; public-research bot)`,
  llmProvider: (): "anthropic" | "claude-cli" | "none" => {
    const p = env("HM_LLM_PROVIDER");
    if (p === "anthropic" || p === "claude-cli" || p === "none") return p;
    if (env("ANTHROPIC_API_KEY")) return "anthropic";
    return "none";
  },
  llmModel: () => env("HM_LLM_MODEL") || "claude-opus-5",
  claudeCliModel: () => env("HM_CLAUDE_CLI_MODEL") || "opus",
  // Per-day analysis budget in USD (enforced for providers that report cost).
  llmDailyBudgetUsd: () => Number(env("HM_LLM_DAILY_BUDGET_USD") || 2),
  gbrainBin: () => env("HM_GBRAIN_BIN") || "gbrain",
  xBearer: () => env("X_BEARER_TOKEN"),
  githubToken: () => env("GITHUB_TOKEN"),
  googleBooksKey: () => env("GOOGLE_BOOKS_API_KEY"),
  youtubeKey: () => env("YOUTUBE_API_KEY"),
  exaKey: () => env("EXA_API_KEY"),
  // Tests may point fetches at a local fixture server.
  allowPrivateNetwork: () => env("HM_ALLOW_PRIVATE_NETWORK") === "1",
};
