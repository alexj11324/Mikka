# Workspace instructions and sharing defaults

P3 of #2956 uses P1's registered settings write/reset/read surface. Workspace instructions are a distinct 2000-character text, stored in `workspace_instructions`; they are not thread title naming instructions. Administrators write and members read. Each product prompt combines platform rules, workspace instructions, then the person's existing personal instructions.

`threadShareVisibility` and `artifactShareVisibility` accept `private`, `workspace`, or `link`. Their default values are `private` and `link` respectively, retaining existing private threads and explicitly created artifact links. Only workspace administrators write these defaults. Reads expose value/source and reset falls back to the registry default. Changing a default does not retroactively publish or revoke existing resources.

`readWorkspaceSharingDefaults(workspaceId)` is an internal consumer for an already admitted resource workspace. It provides both values and provenance, not authorization. Artifact share writers consume it in this P. Thread sharing/lifecycle is owned by #2936; this P supplies its settings contract without duplicating that implementation.

Issue prefixes remain personal `issue_prefixes` plus team identifier, as decided in P1. There is no second workspace prefix.

## New work creation

`newWorkVisibility` accepts `private` or `shared` for new ordinary Bots and root
threads. The personal override belongs to the selected workspace, not the
account globally. Null inherits that workspace's value, then the private
registry default. Members may write their own override; only administrators
write workspace defaults and the boolean `allowPrivateNewWork` (default true).
Both use P1's existing typed settings rows and generic read/write/reset routes;
the reset group is `work-creation`. Task creation retains its separate existing
personal-private/team-shared behavior.

The settings response retains `values` and adds:

```ts
workCreation: {
  configured: { value: 'private' | 'shared', source: 'personal' | 'workspace' | 'default' },
  effectiveVisibility: 'private' | 'shared',
  privateAllowed: boolean,
  reason: 'configured' | 'workspace_policy' | 'personal_workspace'
}
```

Use `effectiveVisibility` to preselect new work. A team which disallows private
work reports shared even when the configured preference remains private; an
explicit private creation is refused with `privateWorkNotAllowed`. Personal
workspaces stay private and refuse an explicit shared selection with
`sharedWorkNotAllowed`. Policy reasons never replace the inheritance source.
The Coordinator remains private regardless of these ordinary-work settings.

The Bot action/desktop RPC, mobile creation route, old `POST /api/bots`, and
the Coordinator's Bot-creation tool consume the same policy before their
creation transaction commits. Existing `visibility` inputs are supported on
the HTTP creation routes as well as the action. A new root thread's explicit
choice travels in the authenticated request's `taskCommand.run.visibility`;
local admission (including read-only runs) and cloud admission consume it.
Dispatching models cannot supply this field through their tool schema.

Workspace membership is pinned before the application transaction, retaining
the existing WS→APP lock order. Policy reads use that transaction's executor.
The existing ACL insert trigger registers the row; initialization changes only
the fresh row's local visibility and never its parent or grants. Changes to
defaults do not rewrite old content, and continuation/retry writers retain
their existing thread boundary. Group execution bookkeeping is not a new
root thread. The historical `insertRunOnce` helper has no production caller.

While a team disallows private new work, its Bot setter and generic Bot/thread
ACL writer also refuse a shared-to-private transition. Already-private
resources remain private; no existing grants or content are rewritten by a
setting change. A child's local shared visibility cannot grant access through
a private ancestor. #2936 still owns fork, side-thread and sharing writers.

The frontend workspace page must keep member-readable workspace policy and a
writable personal override; an administrator-only early return would hide the
member's own setting. The settings page and create dialogs must consume the
new projection before frontend integration can be claimed complete.

The workspace instruction prompt reader resolves the bot's actual workspace and rechecks current membership on every turn. A revoked member cannot obtain the text from a previously owned bot. Formatting keeps platform rules first and strips instruction section delimiters supplied in workspace text.

The existing pre-bot prompt preview remains available with only platform/personal context. An absent or unowned bot provides no workspace instructions; a known bot whose membership or enterprise admission is revoked still fails prompt composition. This preserves the existing missing-bot preview contract without borrowing another bot's workspace.

Migration `20261120192546_workspace_instructions.sql` is additive and replayable, keeps registry writes and prompt storage in one application transaction, and does not change title or personal instruction columns. Roll back application code normally and retain the additive table and its data; no production migration has been run.

Verified locally: 15 prompt assembly/preference unit tests; 9 combined registry/instruction PG17 tests, including unauthenticated, cross-workspace and ordinary-member write rejection, current bot ownership and revoked membership, 2000-character limits, default provenance, reset and migration replay; root/API types, targeted lint, migration checks and 21 CI inventory tests. Artifact share consumption is complete with 6 new PG checks, 14 existing desktop-link/deletion checks, 15 split-database governance checks and 10 artifact units, plus the full 110 migration regression tests. See `docs/settings-backend/artifact-sharing.md` for its access and rollback requirements. Complete CI and deployed frontend acceptance are still pending. No model calls or production migrations.
