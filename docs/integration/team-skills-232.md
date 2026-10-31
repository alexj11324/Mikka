# Team Skill backend acceptance (#232)

The existing immutable Skill artifact, selection, assignment receipt and daemon
mount chain now accepts a workspace-reviewed `mikka-team` artifact. Team metadata
and append-only approvals refer to the existing artifact bytes; there is no second
artifact registry or executable installer.

## Supported format and authority

The workspace API is `/api/workspaces/:workspaceId/skills`. It uses the ordinary
cookie session, current workspace membership and exact-origin writes. Admins may
register a `workspace-upload` with a declared license and review the server-issued
version/digest. Active members may read approved versions and select one for their
own queued run. A run's namespace comes from its stored Bot/task scope; a request
cannot choose another principal or cross workspace boundaries.

The supported format is guidance-only `single-skill-md-v1`, with empty dependency
and permission manifests. Files, archives, symlinks, URL sources, client-chosen
digests, executable plugins and permission/dependency expansion are rejected.
The implementation never fetches or extracts an uploaded archive. This is not
acceptance evidence for a general archive/plugin package manager or a legal review
of a declared license.

Every version starts pending. Updating a logical Skill creates a new immutable
version that needs another review. Selection pins an approved digest; it does not
automatically move existing runs to a newer version. Selecting another approved
version on a new run supplies rollout/rollback. A withdrawn version cannot be
approved again. Historical content/receipts remain readable by authorized admins.

## Withdrawal and execution boundary

Claim, lease renewal and online resume check the current version, review and
membership. A retry/continuation cannot silently discard its parent's protected
Skill. Consumers must declare `x-mikka-team-skills: 1` as well as the existing Skill
artifact capability; these headers grant no authorization.

Withdrawal commits the review, STOP, lease expiry and run-token revocation
together. A queued run without a machine binding ends immediately, with a durable
deduplicated completion event; already machine-bound work follows the existing
stop lifecycle. New Team assignments revalidate online before opening an adapter;
saved resumes retain the existing online check. An offline daemon cannot obtain a
fresh lease or start a saved Skill resume. An already running local process can
continue until its current lease/heartbeat stop boundary; an in-flight external
request cannot be recalled. Server protected actions reject revoked tokens/STOP.

## Local evidence

Isolated PostgreSQL17 database `mikka_admission_closeout_e2e`, loopback55599,
156 migrations including `20261031044142_team_skill_metadata.sql`:

- `team-skills.db.test.ts`: 8/8. Real tables, admin/member/tenant boundaries,
  review/digest, selection/claim, raw bytes and mount verification, actual
  authenticated device receipt handler, old consumer denial, protected retry,
  withdrawal/token rejection/queued completion dedupe, membership suspension,
  immutable evidence and bounded audit metadata.
- Source contract/HTTP plus legacy assignment/registry/audit tests: 24/24.
- Daemon Skill mount and HTTP transport suites: 46/46, including zero adapter
  starts on a withdrawn new assignment or saved resume. These use the existing
  synthetic adapter; they do not prove real native-model Skill execution.

Risk triage: installing unreviewed/cross-tenant guidance or continuing after
withdrawal is an authorization failure (occurrence5 × impact8 = 40). The queued
withdrawal path otherwise leaves a normal queued task permanently unfinished
(occurrence4 × impact4 = 16). The changes reuse existing scope and run lifecycles.

## Remaining issue acceptance

This backend slice has no new main-site Skill management UI, ordinary browser
workflow/video, remote team source integration, or real Codex/Claude/OpenCode
Team Skill model run. Those issue acceptance requirements remain open. The source
tests and authenticated handler invocation must not be presented as GitHub-hosted
CI, a full Next HTTP/browser session, or a real-model/native acceptance run.
