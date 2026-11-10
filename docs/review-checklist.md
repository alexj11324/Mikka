# Review checklist and definition of done

Run this before you show any UI to Alex, in Figma or in code, and before you
approve someone else's UI PR. Each item names the rule it checks. If an item
fails, fix it first; do not show work with known failures.

A paid block or component (BoardUI Pro, affectUI, beUI Pro) is checked against
the library's demo instead: attach a side-by-side and list every visual
difference beyond data and text. The Reuse, Look and Figma items below never
ask to restyle one ([2026-11-09-0050](design/decisions/2026-11-09-0050-paid-blocks-as-shipped.md)).

## Before showing UI

### Reuse (R-90)

- [ ] Every part of the screen names the existing component it uses
      (`docs/design/components.md`, the live screen for the same job, or a
      library in `components/reui/`, `components/ui/`, `components/motion/`,
      the OpenUI catalog), drawn or coded as that component renders it.
- [ ] Any new component says why none of those fit and is added to
      `components.md` in the same PR.

### Usability (first, before anything visual)

Looks and rules are not enough: a screen passes only if people can get done
what they came for. A reviewer who did not build the screen runs this.

- [ ] Task list written from the user's side, not from the UI: owner/admin,
      member and first-time user; first use, daily use and trouble (something
      broke, ran away, needs undo, is needed from yesterday, on the phone).
      Each task cites the feature in code or docs.
- [ ] Each task walked: where a person looks first (cite the convention),
      where it actually is, whether the control exists, and whether it can be
      finished — states, feedback, confirmation, undo, error recovery, empty,
      permission, keyboard, touch and narrow width.
- [ ] Each task rated Found / Hard to find / Missing / Present but
      insufficient, with severity 0–4. No task at severity 3 or 4 is left.
- [ ] Authorization is workspace-scoped: no per-Bot permission settings, no per-Bot allow/ask/deny layer, no per-action approval control (Capy parity).
- [ ] Every capability the code already ships for this area is reachable;
      the change removes no recovery or safety control.
- [ ] The walk-through table (task | before | after) is in the PR body or the
      review page.

### Model

- [ ] Left column lists bots and group chats only; no thread names (R-01).
- [ ] Right 概览 header = the selected bot's avatar and name, then 详情 /
      任务 / PR / 电脑; the 概览 header has no 「<Bot 名> 的屏幕」 (R-02,
      R-17, R-50).
- [ ] Switching bots switches chat, tasks and computer together (R-03).
- [ ] No 新建云端电脑, no per-bot computer list (R-04).
- [ ] Right-panel controls follow R-51, including the existing owner controls
      for an ordinary bot's name, avatar, public role and uploaded files.
- [ ] Every list and tab shows tasks, including 全部任务. Groups are 等待你 →
      进行中 → 待办 → 已完成, with 已完成 collapsed and no 「今天」 group (R-52).
- [ ] Each task row shows its own state's icon. The hand means a task needs
      the person, the octagon means blocked, and the triangle means failed.
      State glyphs use the accepted semantic colours, with no dots or badges
      ([state icons](design/decisions/2026-11-07-2230-one-icon-per-task-state.md),
      [colours](design/decisions/2026-11-08-0130-task-state-icon-colours.md)).
- [ ] A task opens its one conversation through task detail. Attempts and
      活动 run oldest first. Selecting an attempt scrolls to its section, the
      composer addresses the newest attempt, and attempts never show a hand
      ([conversation decision](design/decisions/2026-11-07-2300-one-conversation-per-task.md)).
- [ ] The Artifact rail item uses Mikka's stacked-cards icon, not lucide Copy
      or Library (R-56).
- [ ] The browser toggle is an icon-only globe with no 「浏览器」 label (R-57).

### Leftovers from old components

Grep the screens and the diff for these. They came back from old components
more than once.

- [ ] No input box in the task list or under a computer screen; an open
      thread ends in the standard composer (R-10).
- [ ] The only model picker is a bot composer's `BotModelPicker` chip (R-11).
- [ ] No starter or suggestion cards in a chat (R-12).
- [ ] No avatar or name on messages in a one-to-one chat (R-13).
- [ ] Nothing from the "Do not use" table in `docs/design/components.md` is
      imported by the diff.

### Look

- [ ] No white hairlines in dark mode (R-31). Check inputs, dialogs,
      popovers and column edges.
- [ ] Greys are pure neutral; no slate, zinc or teal tint (R-30, R-38).
- [ ] Only the allowed text styles and radii (R-32, R-33).
- [ ] Status colours from the StatusBadge set (R-34).
- [ ] Every device, agent, model, app and account name has its icon in
      front of it; brand marks are bare colored logos, not in a white
      circle (R-74).

### Layout against Figma

- [ ] Put the screen next to its accepted Figma frame at the same size and
      compare: widths (dialogs especially), order, grouping, spacing. A
      mismatch is resolved by `docs/design/README.md` § When sources
      disagree, and the losing side is fixed or reported.
- [ ] Groupings and order read exactly as the frame shows (machine picker:
      R-23). When a frame can be read two ways, ask Alex before
      building.

- [ ] Every vertical line between two columns drags to resize them, with a
      `col-resize` cursor on hover, arrow keys, double-click to reset, and a
      remembered width; it is a `ResizablePane` or `ResizeHandle` (R-80).

### Copy

- [ ] No filler or explanatory copy (R-40); empty states follow R-41.
      Read every string aloud and delete it; if the screen still says the
      same thing, it was filler. Sheets have no subtitle; reassurance is a
      mark (🔒 Secured by Mikka), not a sentence. Reviewers fail any frame
      with such a sentence, even when the brief asked for it.
- [ ] The Coordinator looks like every other bot: no badge or special copy; the star is only the 置顶 mark, the same on every pinned bot (R-06).
- [ ] All strings in `messages/*.json`; `pnpm i18n:check` passes (R-42).
- [ ] Glossary words only (R-43).

### Completeness

- [ ] Every state in the spec is built: empty, loading, error, dark, narrow.
- [ ] Everything the accepted design already specifies is built. Do not ask
      Alex to accept half of it.

## Showing it

- One Artifact page with all screenshots (light, dark, each state), the
  Figma frame beside each one, and the branch and commit SHA. Screenshots come
  from a local production build (`pnpm build`, `pnpm start`) in cloud Linux.
  The [runtime guide](operations/web-runtime.md) describes the Vite frontend
  and Nitro API outputs.
  No piles of attachments.
- Say which rules or frames you could not follow and why.

## Definition of done (UI work)

1. The checklist above passes.
2. Alex accepted the review page. Design and accepted-frame requirements
   follow [the source priority](design/README.md#when-sources-disagree).
3. Then the flow passes local API/CLI acceptance (not before acceptance of
   the screens).
4. CI is green as the final gate (`CONTRIBUTING.md` § How changes are
   tested); do not run builds on the Mac.
5. Docs updated in the same PR: `rules.md`, `components.md`, a new file in
   `decisions/`, `glossary.md` or the feature spec, whichever the change
   touches.
6. The owning agent merges it once CI is green on the latest head and
   the PR is mergeable, after it has reviewed the screenshots and attached
   them to the PR. It follows the applicable merge strategy in the
   [dev workflow](dev-workflow.md) § 5 and watches the production deployment
   until READY and serving the merge commit. CI and local production-build
   screenshots accept UI, interaction, navigation, refresh, layout and copy.
   Real external services use the production checks in
   [the acceptance guide](acceptance.md#production-acceptance-after-a-merge).

## Common-sense check (every PR)

Every PR review goes through these one by one, UI or not. For each, compare
with what Slack, Notion, Cursor and ChatGPT do.

- [ ] A person can always use, delete and manage their own things:
      subscriptions, keys, computers, bots, files, settings. Switches and
      admin permissions govern only sharing with others
      ([decision 2026-11-01-2240](design/decisions/2026-11-01-2240-own-credentials-always-usable.md)).
- [ ] The value on screen is the value that is stored.
- [ ] No new polling: data changes arrive by live push; the polling allowlist
      grows only for UI timers and external APIs
      ([decision 2026-11-05-0200](design/decisions/2026-11-05-0200-no-new-polling.md)).
- [ ] The default works: no unusable option selected by default, and nothing
      shown online that is not.
- [ ] The same feature behaves the same on the phone and on the web.
- [ ] A refusal or error matches the person's real state: someone with a
      connected subscription is never told to connect one.
- [ ] An idle page does not call the server: reads follow the live channel, not a timer; `pnpm test:idle-budget` passes and `tests/idle-request-budget.json` only goes down (#1212).

## Pull requests

- One topic per PR. Title in the repo's commit style (`feat(scope): …`,
  `fix(scope): …`, `docs(design): …`) with the `MIK-xx` ids.
- The PR body follows `.github/pull_request_template.md`.
- Migrations: idempotent and tested on a real Postgres; see `docs/migration-bootstrap.md` for when they run.
- Small problems a reviewer finds are fixed by the reviewer directly.
