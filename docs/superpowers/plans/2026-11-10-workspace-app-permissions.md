# Workspace app permissions — execution plan

Spec: `docs/design/decisions/2026-11-10-1730-workspace-app-permissions.md`

## Context

The Bot permissions page authorized one Bot at a time. That is the wrong
shape: an app is connected once, and every Bot in the workspace should inherit
the same access choice. The backend already has workspace layers that narrow
every Bot; this plan makes the workspace layer the page's source of truth,
shows the provider's real tool catalogue, and removes the per-Bot picker.

Base commit: `5adf87270` on `feat/bot-permissions-surface`
(worktree `/Users/alexjiang/Desktop/vibe/Mikka-bot-permissions`).

## Global constraints

- Do not run Next.js dev/start/build on this machine. Type tests with
  `node --import tsx --test <file>` or the existing test runner.
- Never commit secrets, tokens or provider payloads.
- Do not edit files outside the task's listed file scope.
- Do not commit or run `git add -A`; the controller owns commits.
- A task that needs a database may write the test and document that CI is the
  gate if no disposable database is available.
- Everything user-visible is in `messages/en.json` and `messages/zh-CN.json`.
- The page authorizes a workspace, not a Bot. There is no Bot-level permission layer or per-Bot setting; do not add one, and remove every per-Bot policy read in this change.

## Tasks

1. **Catalogue backend tests** — `lib/app-tool-catalogue.ts` and new
   `lib/app-tool-catalogue.test.ts`. Prove GitHub pagination/truncation,
   read-only counts, Composio filtering, own-app empty, and error codes with
   injected dependencies. No live provider calls.
2. **Workspace policy DB tests** — new
   `lib/operations/workspace-app-permissions.db.test.ts`. Prove a member reads
   the workspace policy, a non-admin cannot write, an admin can, and an app
   key plus its legacy write key carry the same choice. Use the existing
   disposable-database test harness.
3. **Default view component test** — new
   `tests/bot-permissions-view.test.tsx` (or the repo's existing React test
   location). Render `BotPermissionsView` with fake props: workspace scope is
   stated, no Bot selector, one row per app, tool count and read/write marks
   appear, and a failed catalogue says so.
4. **Hosted overlay finalize** — `/Users/alexjiang/mikka-hosted-ui` only:
   remove the Bot picker for every scope; the page never selects a Bot. Show
   the workspace note, keep the run section, and typecheck. Commit in that
   repository when green.
5. **Messages audit** — `messages/en.json` and `messages/zh-CN.json` only:
   every new key exists in both locales, no stale "Bot permissions" copy, and
   the HostedPermissions block matches workspace scope.
6. **Docs consistency** — `docs/ui-overlay.md`, the new ADR, and any design
   references only: remove stale per-Bot claims and document the workspace
   scope, tool catalogue endpoint, and GitHub deny semantics.
7. **Security review** — read-only. Review `call_app_tool`, the legacy write
   path, and `github_call` enforcement for allow / read-only / disabled behavior
   and workspace-only enforcement; assert that no per-Bot policy is read. Write
   findings to `tasks/bot-permissions-security-review.md`; do not edit code.
8. **Batch CI diagnostic** — `/Users/alexjiang/Desktop/vibe/Mikka-batch`
   only. Read manual CI run `42857391654` logs, extract the DB 3/4
   `review_refusal_debug` / `factory_repair_debug` lines, identify why
   `target_unavailable` persists, and implement the smallest fix if the log
   proves one. Do not merge.
9. **P0 thread-machine review** — read-only review of
   `/Users/alexjiang/Desktop/vibe/Mikka-p0-thread` uncommitted changes:
   five-state lifecycle, snapshot restore, migration ordering, cancel fences.
   Write findings to `tasks/p0-thread-review.md`; do not edit.
10. **P0 macOS review** — read-only review of
    `/Users/alexjiang/Desktop/vibe/Mikka-p0-macos` and PR #1873: 0.38.0 gate,
    TCC status/grant, doctor classes, acceptance script. Write findings to
    `tasks/p0-macos-review.md`; do not claim the real 0.38.0 acceptance passed.

## Review gate

After the tasks report, the controller reviews the combined diff, runs the
targeted tests, and dispatches one whole-branch review before opening a PR.
