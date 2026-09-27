// Evaluation tasks for the "building with AI" goal: turn an experiment log into
// a ship / no-ship decision memo. Every check is deterministic and was fixed
// before any arm was run. Test-split tasks are "locked": their keys never leave
// this module (not exported into skills, not shown in the UI).
export interface EvalTask {
  id: string;
  split: "dev" | "validation" | "test";
  log: string;
  keyNumbers: string[]; // must be cited exactly
  negativeTerms: string[]; // at least one must be mentioned (the negative/null result)
}

export const TASKS: EvalTask[] = [
  {
    id: "dev-1",
    split: "dev",
    log: `Experiment: new retrieval reranker for support-bot answers. 400 held-out tickets.
Answer accuracy: baseline 71.5%, reranker 76.0%. Median latency: 820 ms → 1340 ms.
Cost per 1k answers: $3.10 → $4.40. Human spot-check (50 answers): 3 new hallucinated citations with reranker, 1 with baseline.
The 400 tickets were sampled from March only.`,
    keyNumbers: ["71.5", "76.0", "1340", "4.40"],
    negativeTerms: ["hallucinat", "latency", "March"],
  },
  {
    id: "dev-2",
    split: "dev",
    log: `Experiment: summarization prompt v7 vs v6 for sales-call notes. 120 calls, graded by two reviewers against a fixed rubric.
Rubric pass rate: v6 62%, v7 64%. Reviewer agreement: 0.41 (Cohen's kappa). Token use: -18% with v7.
One reviewer preferred v6 on calls longer than 45 minutes (n=22).`,
    keyNumbers: ["62", "64", "0.41", "18"],
    negativeTerms: ["agreement", "kappa", "longer"],
  },
  {
    id: "val-1",
    split: "validation",
    log: `Experiment: agent auto-fixes failing unit tests. 60 real failing PRs from last quarter.
Tests passing after agent fix: 38 of 60. Of those 38, maintainers rejected 9 fixes as "tests weakened". Mean time to fix: 11 min (agent) vs 47 min (human, historical).
Two fixes deleted assertions.`,
    keyNumbers: ["38", "60", "9", "11", "47"],
    negativeTerms: ["weakened", "deleted assertions", "rejected"],
  },
  {
    id: "val-2",
    split: "validation",
    log: `Experiment: switching embedding model for internal search. 300 queries with labeled relevant docs.
Recall@10: 0.63 → 0.71. MRR: 0.48 → 0.47. Index rebuild cost: $210 one-time. Queries in French (n=40): recall@10 fell from 0.58 to 0.51.`,
    keyNumbers: ["0.63", "0.71", "0.47", "0.51"],
    negativeTerms: ["French", "MRR", "fell"],
  },
  {
    id: "test-1",
    split: "test",
    log: `Experiment: LLM triage of inbound leads. 500 leads labeled by sales ops.
Precision on "hot" leads: 0.82 → 0.88. Recall: 0.74 → 0.66. Leads from non-English forms (n=55) were misrouted 31% of the time vs 12% baseline.
Weekly cost: $95.`,
    keyNumbers: ["0.88", "0.66", "31", "12"],
    negativeTerms: ["recall", "non-English", "misrouted"],
  },
  {
    id: "test-2",
    split: "test",
    log: `Experiment: code-review bot comments on PRs. 200 PRs over 3 weeks.
Comments accepted by authors: 41%. Bugs caught before merge that were confirmed later: 7. False-positive comments flagged as noise: 58%.
Median review turnaround unchanged (4.2 h).`,
    keyNumbers: ["41", "7", "58", "4.2"],
    negativeTerms: ["noise", "false-positive", "unchanged"],
  },
];

export const TASK_PROMPT = (log: string) =>
  `Write a short decision memo (max 200 words) recommending whether to ship the change described in this experiment log.\n\nEXPERIMENT LOG:\n${log}`;

export interface CheckResult {
  decision_stated: boolean;
  cites_key_numbers: number; // fraction 0..1
  mentions_negative_result: boolean;
  no_fabricated_numbers: boolean;
  rollback_or_stop_condition: boolean;
  within_length: boolean;
}

export function checkMemo(task: EvalTask, memo: string): CheckResult {
  const head = memo.split("\n").slice(0, 4).join(" ");
  const numsIn = new Set((task.log.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n))));
  const numsOut = (memo.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(Number(n)));
  const fabricated = numsOut.filter((n) => !numsIn.has(n) && !(Number(n) <= 10 && Number.isInteger(Number(n))) && !/^20\d\d$/.test(n));
  return {
    decision_stated: /\b(ship|do not ship|don't ship|hold|reject|adopt|go|no-go|recommend)\b/i.test(head),
    cites_key_numbers: task.keyNumbers.filter((k) => memo.includes(k)).length / task.keyNumbers.length,
    mentions_negative_result: task.negativeTerms.some((t) => memo.toLowerCase().includes(t.toLowerCase())),
    no_fabricated_numbers: fabricated.length === 0,
    rollback_or_stop_condition: /(roll ?back|revert|stop if|kill (criterion|switch)|guardrail|abort if|halt if|monitor .* (and|then) (revert|stop))/i.test(memo),
    within_length: memo.split(/\s+/).filter(Boolean).length <= 230,
  };
}

export function scoreChecks(c: CheckResult): number {
  return (
    Number(c.decision_stated) + c.cites_key_numbers + Number(c.mentions_negative_result) + Number(c.no_fabricated_numbers) + Number(c.rollback_or_stop_condition) + Number(c.within_length)
  );
}
