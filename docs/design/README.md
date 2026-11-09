# Design docs: start here

Read this page before any design, spec or UI work, in Figma or in code. It
says which source wins when two disagree, and where each kind of rule lives.

## Read in this order

1. [`glossary.md`](glossary.md): what bot, chat, task and thread mean.
2. [`rules.md`](rules.md): the product and visual rules. Every rule has an id
   (`R-12`) so reviews can cite it.
3. [`components.md`](components.md): which component to use for each job, and
   the old components that must not come back. Look up the existing
   component before you draw or build anything (R-90); a design or PR that
   redraws one fails review.
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
| 1 | Alex's latest explicit decision, once it is in `decisions/` (or the frozen `decisions.md`) | Anything it names |
| 2 | `glossary.md` | Words and the bot / chat / thread model |
| 3 | `rules.md` | Product and visual rules |
| 4 | A Figma draft Alex is reviewing now | Layout: what goes where, sizes, order, grouping |
| 5 | The running app on `main` ([decision 2026-11-01-0015](decisions/2026-11-01-0015-main-is-the-design.md)) | Layout everywhere else; it wins over any other Figma frame |
| 6 | Comma (app.comma.surf) | Look and feel: shell structure, density, type, radii, shadows |
| 7 | reUI / shadcn defaults | Only what nothing above covers |

A paid block or component (BoardUI Pro, affectUI, beUI Pro) is outside this
order: the library's shipped demo decides its look, and only data and text
change ([2026-11-09-0050](decisions/2026-11-09-0050-paid-blocks-as-shipped.md)).

Notes:

- A Figma frame counts only if `decisions/` or `decisions.md` lists it as accepted. Frames on
  the 「归档」 page, or marked 已废弃, never count.
- Figma decides layout, not look. Comma decides the look of Mikka's own UI. Old Figma frames use
  zinc greys; the tokens in `rules.md` win.
- The vendored design skills `unslop` and `interface-design`
  (`.claude/skills/`) win over `rules.md` for product and visual rules in
  Mikka's own UI by default (decision 2026-10-31), never inside a paid block; a skill rule that does not fit a dense SaaS
  product is skipped with a reason. Change the rule, its check and the code
  in the same PR.
- Library defaults are the lowest source for Mikka's own UI. A shadcn default
  that breaks a rule there (for example the `border-input` hairline, R-31) is a
  bug, not a choice. A paid block's shipped look is not a default: it stays.
- A measured value (a width, a gap) that differs between Figma and code is a
  conflict. Do not pick one quietly: use the order above, and if it is still
  unclear ask Alex.
- Chat messages, project memory and handoff notes are not sources. Record a
  lasting decision in `decisions/` and update its rule in `rules.md`.
- Feature specs record requirements and their stated implementation evidence.
  Acceptance of a design does not establish that it shipped. Dated audits and
  research keep their original revision and findings.
- There is one UI ([decision](decisions/2026-11-08-2133-one-ui.md)). Describe
  and review what the official build renders. Some pages come from
  `mikka-hosted-ui` through [slots](../ui-overlay.md); the defaults in this
  repository only have to compile and are not a second design.

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
