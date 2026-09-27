// Model access for analysis. Three providers:
//   anthropic  — Anthropic API via the official SDK (ANTHROPIC_API_KEY)
//   claude-cli — the locally installed Claude Code CLI in print mode with ALL
//                tools, MCP servers and settings disabled (pure text in/out)
//   none       — no analysis; items stay "collected, not analyzed"
// Collected source text is passed strictly as data inside <source_material>
// tags; the system prompt tells the model never to follow instructions in it.
import Anthropic from "@anthropic-ai/sdk";
import { config, env } from "../config.ts";
import { getDb, now } from "../db.ts";

export class LlmUnavailableError extends Error {}
export class BudgetExceededError extends Error {}

export interface LlmResult {
  text: string;
  costUsd: number | null;
  provider: string;
  model: string;
}

export function spentTodayUsd(): number {
  const r = getDb().query("SELECT COALESCE(SUM(cost_usd), 0) s FROM llm_usage WHERE created_at >= ?").get(new Date().toISOString().slice(0, 10)) as { s: number };
  return r.s;
}

function record(provider: string, model: string, purpose: string, ok: boolean, costUsd: number | null, inTok: number | null, outTok: number | null, ms: number) {
  getDb()
    .query("INSERT INTO llm_usage (provider, model, purpose, cost_usd, input_tokens, output_tokens, duration_ms, ok, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(provider, model, purpose, costUsd, inTok, outTok, ms, ok ? 1 : 0, now());
}

// Published per-MTok prices used to estimate API cost for the daily budget.
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

let client: Anthropic | null = null;

export async function complete(system: string, user: string, purpose: string, opts: { maxTokens?: number; model?: string } = {}): Promise<LlmResult> {
  const provider = config.llmProvider();
  if (provider === "none") throw new LlmUnavailableError("No model configured (set ANTHROPIC_API_KEY or HM_LLM_PROVIDER=claude-cli)");
  if (spentTodayUsd() >= config.llmDailyBudgetUsd()) throw new BudgetExceededError(`Daily analysis budget $${config.llmDailyBudgetUsd()} reached`);
  const t0 = Date.now();

  if (provider === "anthropic") {
    const model = opts.model ?? config.llmModel();
    client ??= new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
    try {
      const res = await client.messages.create({
        model,
        max_tokens: opts.maxTokens ?? 16000,
        system,
        output_config: { effort: "medium" },
        messages: [{ role: "user", content: user }],
      } as Anthropic.MessageCreateParamsNonStreaming);
      if (res.stop_reason === "refusal") throw new Error("model declined the request (refusal)");
      const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const [pi, po] = PRICES[model] ?? [5, 25];
      const cost = (res.usage.input_tokens * pi + res.usage.output_tokens * po) / 1_000_000;
      record("anthropic", model, purpose, true, cost, res.usage.input_tokens, res.usage.output_tokens, Date.now() - t0);
      return { text, costUsd: cost, provider, model };
    } catch (err) {
      record("anthropic", model, purpose, false, 0, null, null, Date.now() - t0);
      throw err;
    }
  }

  // claude-cli
  const model = opts.model ?? config.claudeCliModel();
  const remaining = Math.max(0.01, config.llmDailyBudgetUsd() - spentTodayUsd());
  const proc = Bun.spawn(
    [
      "claude", "-p",
      "--output-format", "json",
      "--tools", "",
      "--strict-mcp-config",
      "--setting-sources", "",
      "--no-session-persistence",
      "--model", model,
      "--max-budget-usd", String(Math.min(remaining, 0.5).toFixed(2)),
      "--system-prompt", system,
    ],
    { stdin: new TextEncoder().encode(user), stdout: "pipe", stderr: "pipe", cwd: "/tmp", env: { ...process.env, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } },
  );
  const timer = setTimeout(() => proc.kill(), 240_000);
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  let j: any;
  try {
    j = JSON.parse(out);
  } catch {
    record("claude-cli", model, purpose, false, 0, null, null, Date.now() - t0);
    throw new Error(`claude CLI failed (exit ${code}): ${(err || out).slice(0, 300)}`);
  }
  const cost = typeof j.total_cost_usd === "number" ? j.total_cost_usd : null;
  record("claude-cli", model, purpose, !j.is_error, cost, j.usage?.input_tokens ?? null, j.usage?.output_tokens ?? null, Date.now() - t0);
  if (j.is_error) throw new Error(`claude CLI error: ${String(j.result ?? j.subtype).slice(0, 300)}`);
  return { text: String(j.result ?? ""), costUsd: cost, provider, model };
}

export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.search(/[[{]/);
  if (start < 0) throw new Error("no JSON in model output");
  const open = body[start];
  const close = open === "{" ? "}" : "]";
  const end = body.lastIndexOf(close);
  return JSON.parse(body.slice(start, end + 1));
}

export function llmStatus() {
  return { provider: config.llmProvider(), model: config.llmProvider() === "claude-cli" ? config.claudeCliModel() : config.llmModel(), spentTodayUsd: spentTodayUsd(), dailyBudgetUsd: config.llmDailyBudgetUsd() };
}
