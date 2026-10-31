# Settings and onboarding backend additions (#538)

These APIs complement the frontend in #533/#535; no frontend is changed here.

| Action | Input | Result |
| --- | --- | --- |
| `getE2BKey(workspaceId?)` | The workspace displayed by the page | `SettingsActionResult<E2BKeyStatus>` |
| `saveE2BKey({ apiKey }, workspaceId?)` | The displayed workspace; admin required | Same status after verification and storage |
| `deleteE2BKey(workspaceId?)` | The displayed workspace; admin required | `{ removed }` in the settings result |
| `getE2BKeyCapability(workspaceId?)` | The displayed workspace | `{ canEdit, configured, byoEnabled, lastErrorCode, lastErrorAt }` in the settings result |
| `resetOnboarding()` | No person id | Deletes only the authenticated person's completion row |

`E2BKeyStatus` adds `byoEnabled`. `configured` still means a key is saved; it
is distinct from the effective BYO policy. Current main makes BYO mandatory (#523), so `byoEnabled` is true even if the retired `MIKKA_BYO_E2B_KEY` variable is `0`. `canEdit` is true for admins
and false for members. Keys remain write-only. The workspace arguments follow
the other settings actions: old callers may omit them, while pages should pass
the workspace they display. Membership and write permissions are checked against
that workspace before secret storage or provider verification.

## Personal access tokens

Ordinary authenticated API routes accept `Authorization: Bearer mkp_…` through
`lib/api-auth.ts`. The existing SHA-256 lookup refuses malformed, expired and
revoked tokens, and records `lastUsedAt` at most once a minute. Active membership
in the token's workspace is checked on each authentication. An explicit PAT wins
over a cookie; a bad PAT never falls back to a signed-in browser.

The resulting identity is the token owner. Existing owner checks continue to
apply to personal resources, including globally owned Factory tasks. Workspace
APIs use the token's workspace instead of the cookie selection and refuse an
explicit different workspace. Mobile task and chat endpoints accept PATs too; the task list uses the bound workspace and Bot chat refuses a Bot from another workspace. Cookie-based mobile calls retain their existing action path. Subscription and enrollment adapters also enforce
the token workspace before acting on a selected connection or workspace.

PAT support is limited to API adapters. General server actions retain their
browser authentication; API routes that reuse team actions enter the existing
`actAs` boundary with the verified API owner, after checking workspace scope.
A PAT does not create a Better Auth session or cookies. Native authentication
and handoff endpoints, OAuth callbacks,
browser sign-in/handoff endpoints, and existing operations that require
same-origin browser cookies or human-session proof retain those requirements.
No scope system or browser-proof bypass is introduced. Original origin, role,
resource ownership and workspace membership checks still run.

## Verification

`test:pat-api-db` runs the existing workspace and computer-policy route handlers
through loopback HTTP against the isolated PostgreSQL target. It covers GET and
POST, usage tracking, admin/member permissions, the cookie-selected versus token
workspace, explicit workspace mismatch, Bot definition and team scope derivation, group
listing/creation, search scope, server-action exclusion, revocation, expiry, malformed tokens and
suspended membership. Only the Next request context and cookie-authentication
and deferred background wake boundary are fixture adapters; token storage and business authorization are real.

The existing `test:secrets-db`, `test:onboarding-db` and
`tests/workspace-secret-actions.test.ts` cover BYO status/capabilities,
workspace forwarding/refusal and session-owned guide replay.
