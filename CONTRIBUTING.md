# Contributing

Thanks for helping. Ground rules:

1. **Honesty over polish.** Never add fake activity, invented metrics, placeholder testimonials, or a "Live" state the backend did not report. Unknown values stay unknown.
2. **Evidence is data.** Text collected from sources must never be executed, rendered as HTML, or followed as instructions — in the pipeline, the UI, GBrain pages or exported skills.
3. **No secrets or private data in Git.** Credentials live in `~/.human-machine/.env`. Databases, brains, exports and collected content live in `~/.human-machine/` and are git-ignored.
4. **Respect access controls.** New adapters must use official APIs, public feeds, or user-authorized material. Report inaccessible sources as `access_required` rather than scraping around controls.
5. **Tests.** `bun test` must pass. Add a test for every failure mode you fix (see `test/failure-cases.test.ts`).

## Development

```bash
bun install
bun run hm init
bun run hm serve        # http://127.0.0.1:4747 (+ worker)
bun test
bunx tsc --noEmit
```

## Adding a source adapter

Implement `Adapter` in `src/adapters/` (see `types.ts`): declare `capabilities`, `auth`, `discover()` and `collect()` returning items with passages, speaker attribution, and all known dates. Register it in `src/adapters/index.ts`. Missing credentials must block only that adapter.

## Branches

`main` is protected by convention. Use feature branches and pull requests. Agent-generated work should say so in the PR description.
