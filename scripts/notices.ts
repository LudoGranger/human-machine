// Regenerates THIRD_PARTY_NOTICES.md from installed packages (run after bun install).
import { readdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const root = join(import.meta.dir, "..", "node_modules");
const rows: string[] = [];
const visit = (dir: string) => {
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const p = join(dir, name);
    if (name.startsWith("@")) { visit(p); continue; }
    const pj = join(p, "package.json");
    if (!existsSync(pj)) continue;
    const j = JSON.parse(readFileSync(pj, "utf8"));
    rows.push(`| ${j.name} | ${j.version} | ${typeof j.license === "string" ? j.license : j.license?.type ?? "see package"} | ${(j.repository?.url ?? j.repository ?? j.homepage ?? "").toString().replace(/^git\+/, "")} |`);
  }
};
visit(root);
rows.sort();
writeFileSync(join(import.meta.dir, "..", "THIRD_PARTY_NOTICES.md"), `# Third-party notices

Human Machine's own code is MIT-licensed (see LICENSE). It depends on the packages below, each under its own license; their license texts ship inside each package in \`node_modules/<name>/\`.

## npm packages (installed by \`bun install\`)

| Package | Version | License | Source |
|---|---|---|---|
${rows.join("\n")}

## Runtime and external tools (installed separately, not bundled)

| Component | License | Notes |
|---|---|---|
| Bun | MIT | JavaScript runtime — https://bun.sh |
| GBrain (garrytan/gbrain) | MIT, © 2026 Garry Tan | Installed from github:garrytan/gbrain; not vendored or forked |
| Claude Code CLI (optional) | Anthropic commercial terms | Optional local analysis provider |

## Collected content is not covered by these licenses

Software licenses do not grant rights to collected material. Posts, articles, transcripts, commits, books and other sources remain the property of their authors and publishers. Human Machine stores short excerpts with attribution for analysis on your own computer, respects provider terms and deletions, and does not publish collected content in this repository.
`);
console.log(`${rows.length} packages`);
