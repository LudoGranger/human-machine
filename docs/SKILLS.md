# Human Machine — /hm

Build an evolving version of yourself, shaped by the humans you pick.

## Start with one prompt

Open [Human Machine](https://ludogranger.github.io/human-machine/), pick your humans, and copy the setup prompt into your AI. An agent with project file access can install the self-contained `hm` skill. A regular chat can follow the workflow conversationally; it cannot claim to install a skill or retain memory without tools.

## Install the downloaded skill pack

Unzip the download and open the `human-machine` folder in your terminal. Requires Node.js 22 or newer and an agent that reads Agent Skills.

```sh
node scripts/install.mjs --dest /absolute/path/to/your-project/.claude/skills
```

The installer copies `hm`, a compatibility router and six focused action skills. It preserves identical files and stops before overwriting any different existing file. It does not change global settings, start a service or configure a paid provider.

Refresh Claude Code's skill discovery if needed, then use `/hm`.

For Codex, target your project's `.agents/skills` directory and invoke `$hm` or choose the skill in its picker. Invocation syntax is host-specific. The installer is tested; native discovery of this new `hm` entry skill has not yet been qualified in every host. Claude's separately exported person-specific skill has its own verification in the repository's testing report.

## One entry point, ordinary requests

- `/hm pick Brian Chesky for design and Garry Tan for startups`
- `/hm what have my humans shared that matters for this project?`
- `/hm give me feedback on this brief`
- `/hm compare their approaches with my version`
- `/hm mix the changes I chose with my own style`
- `/hm keep this lesson — here is what happened when I tried it`

Pick anyone, including a friend, your father or yourself. For private people, bring the words, advice, stories or notes you choose to share. The skill does not find private profiles or invent their views. Several humans are evidence-based perspectives, not the actual people or their endorsement.

Writing is part of Ask, Compare and Mix. Learning from corrections and outcomes runs through all six actions.

## Fresh sources and memory

The skill uses the tools available in its host. When the Human Machine MCP connector is already configured, it can read current context, changes and evidence. That connector is currently read-only. Keeping a lesson across sessions requires a separate authorized private memory tool; otherwise the skill provides a note to save.

For background source collection and GBrain storage, install the [full local application](https://github.com/LudoGranger/human-machine#install). It is separate from this portable skill download. Provider access, freshness and costs depend on that configuration. The static website does not itself run collectors.

Keep three layers separate: their documented perspective, your experience, and the methods you choose to adopt. New evidence can suggest a revision; your preferences do not rewrite a real person's beliefs. Store private notes outside public Git repositories.

## Development

In the full GitHub repository, `python3 scripts/package-site.py` rebuilds the setup prompt and portable zip from the current skills. The zip includes only its own README, MIT license, manifest, installer and skill text. Runtime data, source archives, tokens and personal memories are excluded.

[Source code](https://github.com/LudoGranger/human-machine) · MIT-licensed original code and skills. Third-party source material retains its own rights.
