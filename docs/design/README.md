# Design docs: start here

Read this page before any design, spec or UI work, in Figma or in code. It
says which source wins when two disagree, and where each kind of rule lives.

## Read in this order

1. [`glossary.md`](glossary.md): what bot, chat and thread mean.
2. [`rules.md`](rules.md): the product and visual rules. Every rule has an id
   (`R-12`) so reviews can cite it.
3. [`components.md`](components.md): which component to use for each job, and
   the old components that must not come back.
4. [`copy.md`](copy.md): how every visible string is written (C-01…C-08), and
   which products set the precedent.
5. [`orchestration.md`](orchestration.md): models, Agents, machines,
   scheduling, credentials in runs and who pays.
6. [`decisions/`](decisions/README.md) (one file per decision) and the frozen
   [`decisions.md`](decisions.md): what Alex decided, when, and what it
   replaced. Check it before you reopen a question.
7. The accepted Figma frames for your feature (listed in `decisions/` or `decisions.md`).
8. [`../review-checklist.md`](../review-checklist.md): run it before you show UI
   to anyone.

New feature? Copy [`spec-template.md`](spec-template.md) first.

## When sources disagree

Higher wins. Fix the lower source in the same PR, or say in the PR which
source is now out of date and who owns it.

| # | Source | Decides |
| --- | --- | --- |
| 1 | Alex's latest explicit decision, once it is in `decisions.md` | Anything it names |
| 2 | `glossary.md` | Words and the bot / chat / thread model |
| 3 | `rules.md` | Product and visual rules |
| 4 | Accepted Figma frame newer than the code | Layout: what goes where, sizes, order, grouping |
| 5 | Merged implementation (from PR #165 on) | Layout where the frame is older than the code |
| 6 | Comma (app.comma.surf) | Look and feel: shell structure, density, type, radii, shadows |
| 7 | reUI / shadcn defaults | Only what nothing above covers |

Notes:

- A Figma frame counts only if `decisions/` or `decisions.md` lists it as accepted. Frames on
  the 「归档」 page, or marked 已废弃, never count.
- Figma decides layout, not look. Comma decides look. Old Figma frames use
  zinc greys; the tokens in `rules.md` win.
- The vendored design skills `unslop` and `interface-design`
  (`.claude/skills/`) win over `rules.md` for product and visual rules by
  default (decision 2026-10-31); a skill rule that does not fit a dense SaaS
  product is skipped with a reason. Change the rule, its check and the code
  in the same PR.
- Library defaults are the lowest source. A shadcn default that breaks a rule
  (for example the `border-input` hairline, R-31) is a bug, not a choice.
- A measured value (a width, a gap) that differs between Figma and code is a
  conflict. Do not pick one quietly: use the order above, and if it is still
  unclear ask Alex.
- Chat messages, project memory and handoff notes are not sources. If a rule
  matters, it goes into `rules.md` or `decisions.md`.

## Where things live and who keeps them

| What | Where | Kept by |
| --- | --- | --- |
| Words | `docs/design/glossary.md` | Whoever changes the model, in the same PR |
| Product and visual rules | `docs/design/rules.md` | Any thread, after Alex decides; the coordinator assigns new ids |
| Components | `docs/design/components.md` | The thread that adds or retires a component |
| Decisions | `docs/design/decisions/`, one file each (`decisions.md` is frozen) | Whoever hears the decision, the same day |
| Brand mark | `docs/design/brand.md` | Any thread, after Alex decides |
| Figma file | `zPe5LKycb2XuT1ivCLRw07`, style guide section `98:2` | Any thread; new work goes on its own page, named with the feature and date |
| Tokens in code | `app/globals.css`, mapped in `rules.md` § Tokens | Frontend threads; any token change updates Figma too |
| Enforced rules | `scripts/lint-ui.mjs`, `scripts/*-policy.mjs`, `ui-policy.json` | Frontend threads |
| UI copy | `messages/zh-CN.json`, `messages/en.json` | The thread that writes the UI |
| Objects, owners, settings levels and the navigation tree | `docs/design/information-architecture.md` | Whoever adds an object, a settings section or a global entry, in the same PR |
| Feature specs | `docs/design/<feature>.md` from `spec-template.md` | The feature's thread |
| Review and done | `docs/review-checklist.md` | Any thread; Alex decides changes to the definition of done |

Project memory keeps only context that does not belong in the repo (Figma
node ids for work in progress, open questions, who is doing what). Rules
move here.
