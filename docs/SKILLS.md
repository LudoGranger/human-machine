# Human Machine — /hm

Build an evolving version of yourself, shaped by the humans you pick.

## Start with one prompt

Open [Human Machine](https://ludogranger.github.io/human-machine/), pick your humans and edit the work you want help with. Click **Add to your AI** to copy the full setup, then paste it into whichever AI you use. The same prompt adapts to the tools available in that conversation; no model selection is needed. **View full prompt** shows exactly what will be copied: your task, your team and the skill instructions. An agent with project file access can install the self-contained `hm` skill. A regular chat can follow the workflow conversationally; it cannot claim to install a skill or retain memory without tools.

## Install the downloaded skill pack

Unzip the download and open the `human-machine` folder in your terminal. Requires Node.js 22 or newer and an agent that reads Agent Skills.

```sh
node scripts/install.mjs --dest /absolute/path/to/your-project/.claude/skills
```

The installer copies `hm`, a compatibility router and six focused action skills. It preserves identical files and stops before overwriting any different existing file. It does not change global settings, start a service or configure a paid provider.

Refresh Claude Code's skill discovery if needed, then use `/hm`.

For Codex, target your project's `.agents/skills` directory and invoke `$hm` or choose the skill in its picker. Invocation syntax is host-specific. The installer is tested; native discovery of this new `hm` entry skill has not yet been qualified in every host. Claude's separately exported person-specific skill has its own verification in the repository's testing report.

## One entry point, ordinary requests

| Action | Example |
|---|---|
| Pick | `/hm pick Brian Chesky for design and Garry Tan for early stage` |
| Catch up | `/hm catch up on what my team has shared that matters for this project` |
| Ask | `/hm ask Brian for feedback on this brief` |
| Compare | `/hm compare their approaches with my version` |
| Mix | `/hm mix Brian’s design principles and Garry’s startup advice with my own style` |
| Keep | `/hm keep this lesson — here is what happened when I tried it` |

These are skill requests to your AI, not terminal commands. Codex uses `$hm` in place of `/hm`. `/hm latest` is also accepted for Catch up. Ordinary language works too.

Pick anyone, including a friend, your father or yourself. For private people, bring the words, advice, stories or notes you choose to share. The skill does not find private profiles or invent their views. Several humans are evidence-based perspectives, not the actual people or their endorsement.

Writing is part of Ask, Compare and Mix. Learning from corrections and outcomes runs through all six actions.

## Fresh sources and memory

The skill uses the tools available in its host. The connected Human Machine MCP server can read current context, changes and evidence. With a keep-scoped token, `hm_pick` starts public-person research and `hm_keep` saves an explicitly chosen lesson to your private GBrain memory with read-back; `hm_list_keeps` retrieves saved lessons. Read-only tokens cannot Pick or Keep. Without an authorized memory tool, the skill gives you a note to save and does not claim persistence. See the [backend setup and verification](https://github.com/LudoGranger/human-machine/blob/main/STATUS.md#the-six-hm-commands-chatgpts-skill--claudes-backend).

For background source collection and GBrain storage, install the [full local application](https://github.com/LudoGranger/human-machine#install). It is separate from this portable skill download. Provider access, freshness and costs depend on that configuration. The static website does not itself run collectors.

Keep three layers separate: their documented perspective, your experience, and the methods you choose to adopt. New evidence can suggest a revision; your preferences do not rewrite a real person's beliefs. Store private notes outside public Git repositories.

## Development

In the full GitHub repository, `python3 scripts/package-site.py` rebuilds the setup prompt and portable zip from the current skills. The zip includes only its own README, MIT license, manifest, installer and skill text. Runtime data, source archives, tokens and personal memories are excluded.

[Source code](https://github.com/LudoGranger/human-machine) · MIT-licensed original code and skills. Third-party source material retains its own rights.
