# Review checklist and definition of done

Run this before you show any UI to Alex, in Figma or in code, and before you
approve someone else's UI PR. Each item names the rule it checks. If an item
fails, fix it first; do not show work with known failures.

## Before showing UI

### Model

- [ ] Left column lists bots and group chats only; no thread names (R-01).
- [ ] Right 详情 header = the selected bot's avatar and name; caption
      「<Bot 名> 的屏幕」 (R-02, R-17).
- [ ] Switching bots switches chat, threads and computer together (R-03).
- [ ] No 新建云端电脑, no per-bot computer list (R-04).

### Leftovers from old components

Grep the screens and the diff for these. They came back from old components
more than once.

- [ ] No input box in the thread list or under a computer screen; an open
      thread ends in the standard composer (R-10).
- [ ] No model picker (R-11).
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

### Layout against Figma

- [ ] Put the screen next to its accepted Figma frame at the same size and
      compare: widths (dialogs especially), order, grouping, spacing. A
      mismatch is resolved by `docs/design/README.md` § When sources
      disagree, and the losing side is fixed or reported.
- [ ] Groupings and order read exactly as the frame shows (machine picker:
      R-23). When a frame can be read two ways, ask Alex before
      building.

### Copy

- [ ] No filler or explanatory copy (R-40); empty states follow R-41.
- [ ] The Coordinator looks like every other bot: no star, badge or special copy (R-06).
- [ ] All strings in `messages/*.json`; `pnpm i18n:check` passes (R-42).
- [ ] Glossary words only (R-43).

### Completeness

- [ ] Every state in the spec is built: empty, loading, error, dark, narrow.
- [ ] Everything the accepted design already specifies is built. Do not ask
      Alex to accept half of it.

## Showing it

- One Artifact page with all screenshots (light, dark, each state), the
  Figma frame beside each one, and the branch, commit SHA and Preview URL.
  No piles of attachments.
- Say which rules or frames you could not follow and why.

## Definition of done (UI work)

1. The checklist above passes.
2. Alex accepted the review page.
3. Then e2e tests are written or updated and pass in CI (not before
   acceptance).
4. CI is green: the CI and Browser tests workflows (`CONTRIBUTING.md` § How
   changes are tested); do not run builds on the Mac.
5. Docs updated in the same PR: `rules.md`, `components.md`, `decisions.md`,
   `glossary.md` or the feature spec, whichever the change touches.
6. Merged to main. Green PRs may be merged without asking.

## Pull requests

- One topic per PR. Title in the repo's commit style (`feat(scope): …`,
  `fix(scope): …`, `docs(design): …`) with the `MIK-xx` ids.
- The PR body follows `.github/pull_request_template.md`.
- Migrations: idempotent and tested on a real Postgres. Migrations run only through `pnpm migrate` (`scripts/migrate.mjs`): in Vercel Production when the Build Command is `pnpm migrate && pnpm build`, or with `MIGRATE=1`; plain `pnpm build` never runs them.
- Small problems a reviewer finds are fixed by the reviewer directly.
