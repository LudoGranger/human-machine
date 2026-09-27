// Validated record shapes. Everything an LLM returns is parsed through these
// schemas; anything that fails validation is discarded, not repaired by guess.
import { z } from "zod";

export const GOALS = {
  building_with_ai: "Building with AI",
  product_decisions: "Product decisions",
  research: "Research",
  communication: "Communication",
  market_policy: "Understanding market / policy developments",
} as const;
export type Goal = keyof typeof GOALS;
export const GoalSchema = z.enum(Object.keys(GOALS) as [Goal, ...Goal[]]);

export const CLASSIFICATIONS = [
  "new_topic", // new topic or method
  "additional_support",
  "refinement", // refinement or exception
  "contradiction",
  "reversal", // explicit reversal
  "retraction",
  "repetition",
  "unclear",
] as const;
export type Classification = (typeof CLASSIFICATIONS)[number];

export const SOURCE_STATUSES = ["live", "polling", "delayed", "historical", "access_required", "failed", "pending"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export const CARD_STATUSES = ["discovered", "tried", "supported", "inconclusive", "rejected", "superseded"] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const Attribution = z.enum(["by_subject", "about_subject", "by_other", "repost_by_subject", "interview", "unknown"]);
export type Attribution = z.infer<typeof Attribution>;

// --- Analysis output (one item) -----------------------------------------
const PassageRef = z.string().min(1); // passage id as provided in the prompt

// Shape coercion only (models vary in JSON typing); evidence checks stay strict.
const boolish = z.preprocess((v) => (v === "true" ? true : v === "false" || v === "unknown" || v === null ? false : v), z.boolean());
const text = z.preprocess((v) => (Array.isArray(v) ? v.join("; ") : v), z.string());
const textOrNull = z.preprocess((v) => (Array.isArray(v) ? v.join("; ") : v === undefined ? null : v), z.string().nullable());
const list = z.preprocess((v) => (typeof v === "string" ? (v.trim() ? [v] : []) : v == null ? [] : v), z.array(z.string()));

export const ExtractedClaim = z.object({
  topic: z.string().min(2).max(120),
  kind: z.enum(["position", "method", "decision", "experiment", "prediction"]),
  statement: z.string().min(8).max(600), // attributed paraphrase
  quote: z.string().min(3).max(800), // exact span copied from a passage
  passage_id: PassageRef,
  speaker_is_subject: boolish,
  matches_existing_claim_id: textOrNull,
  classification: z.enum(CLASSIFICATIONS),
  classification_reason: z.preprocess((v) => (typeof v === "string" ? v.slice(0, 500) : v), text),
});
export type ExtractedClaim = z.infer<typeof ExtractedClaim>;

export const ExtractedCase = z.object({
  situation: text,
  goal: textOrNull,
  constraints: textOrNull,
  available_evidence: textOrNull,
  alternatives: textOrNull,
  action: text,
  stated_reasoning: textOrNull,
  tradeoffs: textOrNull,
  outcome: textOrNull,
  outcome_type: z.enum(["observed", "predicted", "retrospective", "unknown"]),
  passage_ids: list.pipe(z.array(PassageRef).min(1)),
});

export const ExtractedRule = z.object({
  principle: z.string().min(5),
  domain: text,
  activation_conditions: list.pipe(z.array(z.string()).min(1)),
  required_information: list,
  procedure: list.pipe(z.array(z.string()).min(1)),
  decision_criteria: list,
  tradeoffs: list,
  exceptions_and_stop_conditions: list,
  attribution: z.enum(["stated", "inferred"]),
  evidence_strength: z.enum(["weak", "moderate", "strong"]),
  evidence_strength_explanation: text,
  example_use: text,
  example_non_use: text,
  passage_ids: list.pipe(z.array(PassageRef).min(1)),
});
export type ExtractedRule = z.infer<typeof ExtractedRule>;

export const ItemAnalysis = z.object({
  relevant: boolish,
  not_relevant_reason: textOrNull,
  claims: z.array(ExtractedClaim).max(8),
  cases: z.array(ExtractedCase).max(4),
  rules: z.array(ExtractedRule).max(3),
  injection_attempt_observed: boolish,
});
export type ItemAnalysis = z.infer<typeof ItemAnalysis>;

// --- Rule record stored in DB -------------------------------------------
export const RuleData = ExtractedRule.omit({ passage_ids: true, attribution: true }).extend({
  applicable_period: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
  counterevidence: z.array(z.string()),
});
export type RuleData = z.infer<typeof RuleData>;

// --- Learning card --------------------------------------------------------
export const CardBody = z.object({
  what_changed: z.string().min(5),
  why_it_matters: z.string().min(5),
  try_it: z.string().min(5), // bounded exercise on a real task
  success_criterion: z.string().min(5),
  limits: z.string().min(5),
  learn_with_me: list.pipe(z.array(z.string()).min(1)), // guided steps
  improve_my_agent: z.object({
    procedure: list.pipe(z.array(z.string()).min(1)), // proposed skill/workflow change
    evaluation: text,
  }),
  market_policy: z
    .object({
      statement_type: z.enum(["statement", "proposal", "official_decision", "implemented_action", "reporting"]),
      implications: list,
      scenarios: list,
    })
    .nullable(),
});
export type CardBody = z.infer<typeof CardBody>;
