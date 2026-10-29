# Vendored skill audit — 2026-10-29

Scope: the 41 skills under this directory, pinned in [`README.md`](README.md).

## Validation

- `claude plugin validate .claude/skills` → **Validation passed**.
- Every directory has a `SKILL.md`, every frontmatter `name` matches its
  directory, names are unique, and every description is within the 1024
  character limit.
- Every relative link in a `SKILL.md` resolves to a file in the repository.
- Full license texts are present in [`../skill-licenses/`](../skill-licenses/).

## Static safety review

The skill bodies and their six scripts were read before vendoring. No
credential harvesting, secret exfiltration, prompt-injection instruction,
network callback, or destructive shell command was found in the installed
files.

Scripts that require a manual decision before running:

| Script | What it does | Risk |
| --- | --- | --- |
| `systematic-debugging/find-polluter.sh` | Runs `npm test` for each matching test file to find state pollution | Starts many test processes; review the pattern before running |
| `brainstorming/scripts/start-server.sh`, `stop-server.sh`, `helper.js` | Starts/stops a localhost collaboration server | Local server, session files; do not bind publicly without review |
| `writing-skills/render-graphs.js` | Invokes Graphviz `dot` on Markdown diagrams | Requires Graphviz; only writes SVG output |
| `roundtable/table.py` | Sets up a private mock-VC case, validates quoted votes, tallies results and writes `.roundtable/REPORT.md` | Local files only; no network or subprocess calls. The agent supplies the role-play prompts |

None of these scripts is run by application code, CI or `pnpm install`.
They run only if an agent or person explicitly invokes them.

## Quality notes

- **Trigger overlap**: `systematic-debugging` and `debug` overlap, and the
  three UI collections overlap. [`README.md`](README.md) records the precedence
  (`systematic-debugging` for root-cause work, `incident` for production
  mitigation, `settings-pages` for Settings IA).
- **Description style**: the superpowers and proven-skills descriptions often
  start with a role statement rather than `Use when…`; they still include
  concrete trigger phrases. This is a style deviation, not a validation
  failure.
- **Heavy references**: `writing-skills` (399 lines) and
  `saas-design/components.md` (44 KB) are intentionally progressive-disclosure
  references, not loaded into every prompt.
- **Roadshow boundary**: `yc-pitch-deck` is prompt-only and contains no
  script or network call; its frontmatter mentions a vendor MCP server, which
  this project does not install or require. `roundtable` is a rehearsal tool,
  not a source of real investor interest, and its generated files belong
  outside the repository (`.roundtable/`).
- **Provenance drift**: upstream skills change. Update by replacing a whole
  skill directory from a new pinned commit and rerunning this audit; do not
  edit vendored files in place without recording the patch.

## How this audit was performed

The checks follow the vendored `writing-skills` standard (validation,
trigger descriptions, file layout, script handling) plus a static scan for
network/secret/destructive patterns. `writing-skills` itself requires a
baseline failing scenario before changing a skill; we therefore do not modify
upstream skill text during vendoring. Project-specific rules remain in
`AGENTS.md`, this README and the SaaS review, not inside the vendored files.
