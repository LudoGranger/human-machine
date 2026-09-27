# Testing

```bash
bun test          # 30 tests: failure cases + real GBrain integration (skipped if gbrain is not installed)
bunx tsc --noEmit
```

## Automated failure-case tests (`test/failure-cases.test.ts`)

| Failure mode | What is checked |
|---|---|
| Wrong identity | Two exact-name people of comparable prominence → clarification; dominant candidate resolves; non-human namesakes ignored; another contributor's commit is not attributed to the person; co-author trailers kept separate |
| Wrong speaker | Transcript interviewer turns are not the person's; quoted posts keep their own author; reposts are not statements or endorsements |
| Duplicate news | Same URL with tracking params = duplicate; same-event reports cluster; syndicated identical text is stored with lineage but analyzed once |
| Old content republished as new | Old post discovered today is Historical and not analyzed as a new development |
| Edited / deleted posts | Edit → version 2 of the same item; deletion purges stored text and marks dependent claims and change events stale |
| Unavailable transcripts | Appearance without transcript → metadata only, not analyzed |
| Contradictory evidence | "Reversal" without explicit language → contradiction; contradiction without a real prior claim → unclear; quotes must be verbatim |
| Crawler restart | Jobs left running by a dead worker are re-queued; idempotency keys prevent re-analysis |
| Prompt injection | Untrusted text cannot form frontmatter/headings/fences in GBrain pages; model output that follows injected text is rejected by evidence checks and flagged |
| Cross-user leakage | Another user's token sees no goals or cards; invalid tokens rejected; private GBrain brains are separate per user |
| Network safety | Loopback, private, link-local/metadata, `file:` and credentialed URLs are blocked; X reconnect backoff matches the documented strategy |

## Real GBrain integration (`test/gbrain.test.ts`)

Uses the installed `gbrain` CLI with throwaway brains: write → keyword search → read on the public layer; a page written to one user's private brain is not found from another user's brain or the public brain.

## Manually verified on the build machine (macOS 26, Apple Silicon, Bun 1.4.2, GBrain 0.59.0.0)

| Check | Result |
|---|---|
| Live research of Garry Tan from public sources | Pass — see STATUS.md |
| Worker hard-killed mid-job, restarted | Pass — orphaned jobs re-queued and completed |
| Retrieval through GBrain supporting a displayed card | Pass — `gbrain_support.hits` recorded on cards |
| Claude Code (CLI 2.1.117): fresh `claude -p` session loads the project skill, runs the refresh script, reports `refreshed_at` and the newest change | Pass |
| Skill refresh with server down | Prints last cache labelled "FAILED — serving STALE cached context", exit 4 |
| Agent API with bad token / write method | 401 / 405 |

## Clients and platforms

| Client / OS | Status |
|---|---|
| Claude Code on macOS (skill + script) | Tested |
| MCP server (`hm mcp`) over stdio JSON-RPC | Tested (initialize, tools/list, tools/call against the live API); not yet exercised inside a Claude Code MCP session |
| Claude Desktop, Cursor, Codex, other Agent Skills clients | Untested |
| Linux | CI only (GitHub Actions, ubuntu-latest) |
| Windows | Untested |
