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
156 migrations including `20261031050733_team_skill_metadata.sql`:

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

The original issue explicitly allows choosing the first registry source and
supported plugin format. `workspace-upload`, workspace-admin approval and
`single-skill-md-v1` are the implemented choices. An empty dependency/permission
manifest describes this guidance-only format; it is not a promise to implement
executable packages. Remote registries, archives and other plugin formats are
outside this first scope, rather than unfinished requirements. Rejecting those
inputs before fetching or extraction is the applicable refusal contract.

The backend lifecycle within that chosen format is implemented. Selection on
each new run supplies controlled distribution and rollback to an older approved
version. New versions require new approval; existing selections stay pinned.
An unselected retry or question descendant cannot drop an ancestor's protected
Skill. Question continuations that retain the selection recheck its current
eligibility. Native harness children share the existing run and tool gate; they
do not acquire a new approval or receipt. Withdrawal revokes the run token and
lease, and the daemon's stop path revokes the tool gate and cancels the CLI
process tree at the documented running-task boundary.

The applicable acceptance still missing is a main-site management workflow with
the requested screenshots/video, and real native-model runs across supported
harnesses. The UI dependency belongs to Claude. There is no new backend package
format or remote-source implementation prerequisite for those checks. Keep the
issue open until the applicable user-path acceptance is complete. Source tests,
authenticated handler invocation and synthetic adapters do not establish a full
Next/browser session or real-model execution.

## Scope recheck, 2026-10-31

At main `3e2135e3685268aecffd25a994914e7781409c47`, the unchanged suites passed:

- Real PostgreSQL17 lifecycle: 8/8, zero skipped, using the existing isolated
  `mikka_admission_closeout_e2e` on loopback55599. It checks review, tenant/member
  boundaries, assignment and disk digests, authenticated receipt revalidation,
  protected retry refusal, withdrawal, STOP/token/lease fencing and immutable
  audit evidence. New append-only fixture records were retained; prior records
  and immutability guards were not modified.
- Contract, HTTP handler and actual filesystem/RunContext checks: 8/8.
- Daemon mount/resume and HTTP transport suites: 46/46. The approved Team Skill
  reaches the existing synthetic adapter; withdrawn fresh assignments and saved
  resumes start no adapter. This is daemon wiring evidence, not a native-model
  demonstration.

The first attempted PostgreSQL run used `mikka_audit_closeout_e2e`, which lacks
the Team Skill tables and failed before registration. No schema was changed;
the successful rerun used the already migrated Team Skill acceptance target.
Local logs are `/tmp/mikka-team-skill-232-closeout-{pg,contract,daemon}.log`.
The recheck found no additional missing core hook in this first supported format;
it does not change production behavior or widen plugin permissions.
