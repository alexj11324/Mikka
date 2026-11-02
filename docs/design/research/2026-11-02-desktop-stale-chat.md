# Desktop chat retained an old deployment

## Observed failure

The user could chat on the production website while the existing desktop
window failed. The window still showed the older composer. Production logs
at 20:55–20:56 UTC contained failed workflow requests to the old
`dpl_4GtLxkCNQaoy5j7zTraDBwLqG7E5` after the replacement deployment was
already serving the production domain. The user confirmed that Cmd+R made
desktop chat work immediately.

Occurrence 8/10 (desktop windows remain open across releases), impact 6/10
(chat can keep invoking broken old code). This warrants a targeted repair.

The desktop renderer loads the production website; its native installer
does not bundle this chat UI. A pending desktop installer is therefore not
evidence that the chat fix is unavailable to the window.

## Mechanism and sources

Next 16.4.1 attaches the page's deployment ID to Server Actions. Vercel
Skew Protection can route those calls to that deployment. A removed-action
handler cannot recover when the old deployment still serves the action.

- [Vercel Skew Protection](https://vercel.com/docs/skew-protection)
- `node_modules/next/dist/client/components/router-reducer/reducers/server-action-reducer.js`
- `components/version-guard.tsx`, `lib/app-build.ts`
- `apps/desktop/scripts/build.mjs`, `apps/desktop/src/main/index.ts`

## Repair

Keep the existing [no-refetch-on-focus decision](../decisions/2026-11-01-0400-no-refetch-on-focus.md).
Check the public, stable `/api/version` during explicit navigation (including
query-only Bot changes), sending and retrying. Omit cookies and deployment
affinity headers; use no-store, one shared in-flight request and a one-minute
check interval. A network failure does not pretend a newer build exists.

When the page is known stale, sending/retrying stops before optimistic
changes or transport and raises the existing update notice. Draft text,
attachments, notes and quotes stay intact. The user chooses Refresh; no
focus/timer reload or global busy registry is added.

The initial recovery of an already open old window still requires a reload:
new client-side recovery code only runs after that window loads it.

Actual behavior regressions cover request deduplication, throttling, public
fetch options, query-only navigation and stale send/retry preserving input
without submitting. The collapsed model picker separately follows the
[model-name-only decision](../decisions/2026-11-02-2058-composer-model-name-only.md).
