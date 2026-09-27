// Every test run gets an isolated data dir; no real credentials are visible.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.HM_DATA_DIR = mkdtempSync(join(tmpdir(), "hm-test-"));
for (const k of ["ANTHROPIC_API_KEY", "X_BEARER_TOKEN", "GITHUB_TOKEN", "GBRAIN_REMOTE_URL", "GBRAIN_REMOTE_TOKEN", "HM_LLM_PROVIDER"]) process.env[k] = "";
process.chdir(process.env.HM_DATA_DIR); // ignore any repo-level .env
