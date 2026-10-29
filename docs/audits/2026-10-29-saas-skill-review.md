# SaaS review through the vendored skills — 2026-10-29

Scope: the web app + Electron shell at `main` plus the pending desktop OAuth
change. Method: `systematic-debugging` (root cause first),
`incident`/`perf`/`node-ops` (production readiness), `security` (trust
boundaries), `db-review` (queries/indexes), `arch-review` (coupling), and the
`settings-pages` / `forms-and-validation` / `empty-and-loading-states`
checklists.

This is a code and design review, not a penetration test or a load test. It did
not use production data or credentials.

## P0 — must be fixed before the next public desktop release

### 1. Third-party OAuth was embedded in the Electron window
`apps/desktop/src/main/security.ts:24-37` allowed `accounts.google.com` and
`github.com` as in-window navigations, and
`apps/desktop/scripts/build.mjs:15` hard-coded those origins. Clicking Google
therefore rendered Google's account page inside the app, which is not an
allowed OAuth user-agent.

**Status:** fixed in PR #422 (system browser + one-time-token handoff). It is
not in the published 0.1.0 build; 0.1.1 is the replacement. Do not publish
0.1.1 until the web app carrying `/api/desktop/return` is deployed.

## P1 — fix before calling the desktop release complete

### 2. Desktop account/integration linking still assumes an in-app callback
With the new navigation policy every provider page is external, but these
flows still finish by redirecting the **browser** to an app callback:

- Google account link: `components/settings/google-sign-in-settings.tsx:57-65`
- GitHub account link: `components/settings/integrations-settings.tsx:72-81`
- Linear connect: `components/settings/linear-settings.tsx:73-78`
- Composio connect: `components/plugins/connected-apps.tsx:112-119`

The browser gets the OAuth result; the Electron window does not. Before the
policy change this worked for Google/GitHub by embedding them; now it cannot.
The safe options are (a) open the corresponding **web Settings page** in the
system browser and let the person link there, then refresh on focus, or (b) add
the same nonce/token handoff used for sign-in to a linking flow. Do not put the
provider page back in the window.

### 3. No Content-Security-Policy on app responses
`next.config.mjs:58-65` sets HSTS, `X-Frame-Options`, `Referrer-Policy`,
`X-Content-Type-Options` and `Permissions-Policy`, but no CSP. The auth handoff
routes set a narrow CSP locally; the main app does not. Start with a
report-only policy, remove inline-script needs, then enforce. This is the
highest-leverage XSS defense-in-depth gap.

### 4. Production debugging is mostly request logs
`lib/request-log.ts` is a good redacted request log (route template, status,
duration, hashed user), but there is no server error aggregation or tracing
hook in the repository. `app/api/health/route.ts:5-14` is liveness only; it
does not check the database or queue. During an incident the team can see
`api_request` lines but not a stack/error group or a dependency-health signal.
Add server error reporting (Sentry or equivalent), a readiness endpoint
(DB/pool + critical queue), and an incident runbook with rollback/flag steps.

### 5. Rate limiting covers email auth routes only
`lib/auth-email.ts:126-131` limits verification, password reset and reset
confirmation. General server actions and API routes (including polling and
agent dispatch) have no common limiter; only specific workflows return 429 on
their own quotas. Add a shared per-user/IP limiter for write actions and
expensive reads, with an explicit allowance for background jobs.

## P2 — schedule next

### 6. Desktop/web release coupling
The desktop shell loads the remote web UI, so PR #422's fix only reaches users
after the web deployment is live. Add a release gate: deploy web first, verify
`/mikka/api/desktop/finish` returns 200, then publish the desktop release.
Record the web deployment SHA with the desktop release.

### 7. Polling queries lack a composite index
`app/actions/task-runs.ts` polls `listTaskRuns` / `listThreads` for the desktop
badge. `agent_runs` indexes at `lib/db/schema.ts:302` cover `(deviceId,
status)`, `(issueId, createdAt)`, `(botId, createdAt)` and a partial dispatch
key, but not `(userId, issueId, createdAt)` or `(userId, createdAt)`. The
`where userId = … and createdAt > now() - 30 days` paths therefore need
verification with `EXPLAIN (ANALYZE, BUFFERS)`. If they scan, add a composite
index in a migration. This is especially relevant because the desktop polls
every 15 seconds.

### 8. Destructive Settings actions lack a confirmation step
`components/settings/subscription-settings.tsx:120-123` removes a subscription
connection immediately, and `components/settings/memory-settings.tsx:62`
deletes a memory fact with a single icon click. `settings-pages` asks for a
confirmation on irreversible actions and a danger-zone separation. A small
alert dialog with the exact consequence is enough; keep the existing
`AlertDialog` pattern used by members.

### 9. Unsaved issue-prefix edits can be lost
`components/settings/issue-prefix-settings.tsx` uses explicit Save, but has no
dirty guard on section/sidebar navigation. `settings-pages` requires an
unsaved-changes warning for explicit-save forms. Add a route/section guard or
autosave once the value is valid; do not mix both models on the same row.

## P3 — confirm intent

- `components/settings/settings-view.tsx:42` renders language as static text.
  If language switching is meant to exist, it is missing; if the locale is
  deployment/browser-derived by design, keep it as documentation.
- `components/settings/workspace-settings.tsx` is read-only by design. If
  renaming a workspace is a product requirement, it needs an explicit Save
  model and permission check; otherwise leave it.

## What is already good

- One Settings surface (`components/settings/settings-view.tsx:40-47`), with a
  sidebar and `/devices` redirect; no second settings page.
- Last-admin protection is enforced server-side in
  `app/actions/workspace.ts:118-120`, not only hidden in the UI.
- Request logs never include headers, cookies, tokens, bodies, query strings or
  emails (`lib/request-log.ts`).
- Server actions consistently use `requireUser` / `requireWorkspace` /
  `currentUser` / `requireIssueAccess` rather than trusting client input.
- The Electron bridge is narrow and each IPC handler validates the sender and
  payload; the new OAuth bridge method accepts only app-origin HTTP(S) URLs.
- Settings use semantic tokens and the existing UI policy; no ad-hoc palette.

## Suggested order

1. Finish #422, add the browser-settings fallback for account/integration
   linking, deploy web, then release 0.1.1.
2. Add server error reporting + readiness; write the first incident runbook.
3. Add CSP in report-only mode.
4. Add the shared rate limiter.
5. Add the polling index migration after `EXPLAIN` confirmation.
6. Add confirmations for subscription removal and memory deletion; add the
   issue-prefix dirty guard.
