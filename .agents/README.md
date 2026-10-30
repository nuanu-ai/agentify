# Project skills

Codex discovers the checked-in skills under `.agents/skills/` when working in
this repository or its subdirectories. Each skill has its own `SKILL.md` with
the name, description and workflow. This uses the [documented repository skill
location](https://developers.openai.com/codex/skills/#where-to-save-skills);
no Codex configuration or startup hook is required. Codex selects skills by
their descriptions, or a user can invoke one explicitly with `$humanizer`,
`$test-audit`, `$ponytail` or `$impeccable`.

| Skill | Purpose | Source |
| --- | --- | --- |
| humanizer | Edit prose without changing its supported meaning | Project's existing MIT-licensed Humanizer 3.1.0 |
| test-audit | Write and review tests under Agentify's proof policy | Existing project adaptation; attribution and policy are in its folder |
| ponytail | Keep coding changes small and complete | Snapshot of the user's existing MIT-licensed skill |
| impeccable | Design and improve interfaces | Codex build from [pbakaus/impeccable](https://github.com/pbakaus/impeccable/tree/02523aec3e4c4580102d996d1b6a71fbe062e03f/.agents/skills/impeccable), version 4.8.0, Apache-2.0 |
| interface-review | Review Agentify screens against the product's own rules | Existing project skill |

The Humanizer and test-audit entries in `.claude/skills/` are relative links
to these same project files. The checked-in skills do not link to a developer's
home directory. A separately installed user skill with the same name may also
appear in Codex's selector; Codex does not merge skills with identical names.

Impeccable includes its reference playbooks, launchers, engine version and
checksum manifest. Its executable launcher downloads the matching engine on
first use into the user's Impeccable cache and verifies it against that
manifest. That first use needs network access. No detector hook is installed;
the skill's design workflows can be invoked directly, for example
`$impeccable critique` with a target screen. Installation alone does not create
`PRODUCT.md` or `DESIGN.md` or establish any design acceptance result.

Update a skill by replacing its project files on a branch, preserving its
license and supporting files, updating the source here and reviewing the diff.
For Impeccable, copy `.agents/skills/impeccable/` from a specific upstream
commit, include the root upstream `LICENSE`, and preserve the executable bit
on `scripts/impeccable`. The imported Markdown has trailing whitespace
removed; `.gitattributes` preserves Windows launcher line endings. Biome
excludes this upstream bundle, including its generated browser JavaScript,
so project lint does not rewrite third-party code. Keep Agentify's local
design and proof policies.
Codex detects skill changes automatically; restart it if a skill does not
appear.
