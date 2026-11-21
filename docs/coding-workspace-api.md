# Coding Workspace API

Backend owner: #1720. Files milestone: #1721. UI consumers: #1731–#1735.
The exported Zod schemas and TypeScript types in
`@mikka/protocol/coding-workspace` are the wire contract.

## Identity and authority

`RunWorktreeIdentity` contains `version: 1`, `runId`, `repoId`, `deviceId`,
`workspaceId`, `ownerId`, canonical `repositoryKey` and opaque `bindingId`.
The browser supplies only the selected Run, repository and Workspace IDs.
The server resolves the actual device, original claim token, checkout and
machine binding. It never accepts a browser-supplied filesystem root or sandbox.

Files currently require the Run owner. Shared task visibility alone does not
grant access to another member's computer. A fresh session or workspace-scoped
PAT, current membership, current task visibility, repository binding and
original device credential must all be valid. Frozen execution, repository
admission, claim-token and thread-machine Workspace evidence must agree.
An older Run without any non-null frozen Workspace evidence is unavailable;
moving its task to a Workspace cannot grant access to the old checkout.

The device resolves the same Run from its persisted `RunJournal`. Its Run,
repository, device and canonical origin must match. `bindingId` changes when
the checkout, original token, machine sandbox or machine generation changes.
Human session/PAT validity is checked again after a device round trip. Before
returning successful source or mention metadata, a short WS-to-APP transaction
holds the current workspace, membership, task, Run, credential and live device
binding while refreshing the source policy and serializing the response.

This layer consumes existing Repo and task authorization. Canonical
Project/Environment and no-Team task authority remain owned by #1687/#1695;
their final integration must be tested on the merged API, not inferred from a
synthetic machine row. There is no new Project/Repo permission database here.

## Files endpoint

All paths below are relative to the application's configured base path
(`/mikka` by default).

First call `GET /api/runs/{runId}/workspace/identity?workspaceId={workspaceId}`.
It returns `{ok: true, identity: RunWorktreeIdentity}` after the complete
owner/Workspace/Run/machine authorization above. Use its `repoId` for the
following requests. A Bot runtime's repository ID is not interchangeable with
the task VM's repository ID. The response never contains a filesystem root,
sandbox ID or device token, and does not grant access beyond the current Run.

`GET /api/runs/{runId}/workspace/files`

| Query | Meaning |
| --- | --- |
| `workspaceId` | Selected Workspace; a PAT cannot select a different scope |
| `repoId` | Required repository UUID belonging to this Run and device |
| `kind=tree` | Root or immediate children; default kind |
| `path` | Repository-relative path; defaults to the root for tree |
| `cursor` | Opaque tree cursor, bound to the directory inventory revision |
| `limit` | Tree: 1–200, default 100; search: 1–100, default 30 |
| `kind=file` | One file's metadata and a bounded text range |
| `startLine`, `endLine` | Both required when specifying a range; inclusive, one-based, at most 2,000 lines |
| `headSha`, `contentSha256` | Both required for an expected file revision; mismatch is a conflict |
| `kind=search`, `query` | Case-insensitive substring search of allowed repository paths; 1–200 characters |
| `source=working` | Explicit current-checkout observation; this endpoint does not silently substitute another source |

An unsupported `source` or a `ref` parameter returns `workspace_unsupported`.
Historical checkpoint/commit/PR reading uses the source contract delivered by
#1722/#1726. A retained local checkout is still an observed working tree;
it is not relabelled as an immutable checkpoint because the Run has ended.
A stopped, released or missing cloud machine cannot return live files.
Existing checkpoint/PR evidence remains separate from a live read.

Every successful response has:

```ts
{
  ok: true,
  identity: RunWorktreeIdentity,
  revision: {
    source: 'working',
    headSha: string,
    baseSha: string | null,
    version: string // SHA-256; opaque to the client
  },
  observedAt: string, // ISO timestamp of this observation
  availability: 'online',
  kind: 'tree' | 'file' | 'search' | 'context'
}
```

Tree responses add `path`, `entries`, `nextCursor` and `truncated`. Each entry
contains `path`, `name`, `kind: 'directory' | 'file'` and `size: number | null`.
Size is unavailable for directories and unsafe/unreadable entries; a listed
path is not a grant to read a symlink target. Search returns matching file
entries and `truncated`, without reading their content.

File responses add `path`, `size`, `format`, `content`, `contentSha256`,
`language`, `startLine`, `endLine`, `totalLines`, `truncated` and `editable: false`.
`format` is `text`, `binary`, `too_large` or `unsupported`. Only `text` has
content. UTF-8 is decoded strictly, preserving BOM and CRLF. Empty files have
one empty line. The default text range starts at line 1 and contains at most
2,000 lines and 256 KiB of UTF-8 content. A requested start past EOF is invalid.
A line that alone exceeds the byte budget is rejected, not split silently.

`headSha` identifies the checked-out Git commit. `contentSha256` hashes the
complete raw file, including any BOM and exact line endings. A file's `version`
also binds its path and HEAD. The tree revision describes the path inventory;
it is not a claim that every file's content was read atomically.

## File and folder mentions

`POST /api/runs/{runId}/workspace/mentions`, with JSON content type:

```ts
// Select source and receive a reference. No source bytes are stored in it.
{
  action: 'create', workspaceId, repoId,
  selection: { kind: 'file', path, range?: { startLine, endLine } }
  // or selection: { kind: 'folder', path }
}

// Reauthorize and reread the exact selected versions.
{ action: 'resolve', workspaceId, repoId, ids: [mentionId] }

// Supplement this exact active Run through its existing owner-message inbox.
{ action: 'submit', workspaceId, repoId, ids: [mentionId], text, requestId }
```

Creation returns HTTP 201 with `{ok: true, mention}`. A mention contains its ID,
Run/repository IDs, original selection, resolved relative paths/ranges with
expected HEAD/content hashes, revision, omitted count and expiration time.
Its lifetime is ten minutes and its machine binding must still match.
`resolve` returns a context observation containing the files in selection order.
Rename, deletion, changed bytes, changed HEAD, or a new machine generation
requires a new selection; none is silently rebound to a newer Run.
A folder selection is rejected with `workspace_limit_exceeded` (429) when it
contains more than 20 candidate text files (text extension or name) or more
than 64 KiB of selected content. `omitted` counts selected text-classified
paths whose content is binary or exceeds 1 MiB; non-text extensions (e.g.
`.png`) never enter `selected` and are not counted. The 21st candidate is the
429, never an omitted file. A `resolve` or `submit` with several mentions is
limited to 20 entries in total; the same path in two mentions counts twice.
A mention does not carry a `truncated` flag for large files yet; that flag is
deferred.

Submission requires a real human session and same-origin `Origin`. PATs can
create and resolve references but cannot impersonate a human submission.
The message is explicitly labelled as user-selected untrusted source context.
Attachment-looking strings inside source remain inert JSON data.
The complete message, including source, must fit the existing 10,000-character
inbox limit. Resolution's larger read budget does not bypass that limit.

Submission returns `{ok: true, runId, continued: false, messageId}`. It never
continues a finished thread, follows a successor Run, or advances a Factory
request epoch. Under the existing Task → Issue → Run lock order, the current
Factory attempt, Run chain, machine binding, human session and Workspace
membership are rechecked. The existing `run_messages` table provides the
idempotent owner message. Reusing `requestId` with different message content is
a conflict. A submit must target the current Run chain's latest Run, the current
Factory attempt (for a Factory-bound Run) and the current machine binding; an
earlier or superseded Run is a `workspace_version_conflict`, while a different
Run/repository authority is `workspace_not_found`. Device wake happens after the
owning transaction commits.

## Git status, history and safe writes

Git reads reuse the Files identity and the Diff review contracts; there is no
second Git fact source. Status, history, revert and restore all observe the
same checkout authorized by the existing Run/repository binding.

```ts
GET  /api/runs/{runId}/workspace/git/status?workspaceId&repoId
GET  /api/runs/{runId}/workspace/git/history?workspaceId&repoId&cursor&limit
GET  /api/runs/{runId}/workspace/git/checkpoints?workspaceId&repoId
GET  /api/runs/{runId}/workspace/git/commits/{commitSha}/diff?workspaceId&repoId&baseSha&cursor&limit

POST /api/runs/{runId}/workspace/git/revert/preview   { workspaceId, repoId, operationId, snapshotId, path, target }
POST /api/runs/{runId}/workspace/git/revert           { workspaceId, repoId, operationId }
POST /api/runs/{runId}/workspace/git/undo             { workspaceId, repoId, operationId, undoOf }
POST /api/runs/{runId}/workspace/git/checkpoints/restore/preview { workspaceId, repoId, operationId, checkpointId }
POST /api/runs/{runId}/workspace/git/checkpoints/restore         { workspaceId, repoId, operationId }
```

Live metadata is `git status --porcelain=v2 --branch -z --untracked-files=all`
plus `git log`, both read through the pinned descriptor and re-checked against
HEAD before the receipt is returned. Each status entry carries its index and
worktree state, path/previous path, mode, size, raw content hash and an opaque
stat fence (`workingVersion`). `binary` is `null` when the bounded observation
could not decide; `lfs` marks Git LFS pointers. Unlike the file reader, status
and history are read-only metadata: content hashes describe bytes, they do not
expose them. A commit diff is the existing `diff_snapshot`/`diff_file` contract
with `selection: {source: 'commit', baseSha, headSha}`.
Upstream ahead/behind is reported only when the configured remote resolves to
the same canonical repository key, so a local `origin` cannot invent a
relationship with someone else's GitHub repository.

A revert is bound to one immutable local Diff snapshot and to exactly what the
person reviewed:

1. Preview re-derives the snapshot version and the file's exact bytes on the
   device. The server keeps the reverted bytes server-side, verifies them
   against the snapshot's blob proofs and returns a `previewVersion` that binds
   operation, revision, file, selected hunk fingerprints and both working-tree
   fences. Previews live five minutes and are single-use intents.
2. Apply recomputes `previewVersion`, re-reads HEAD and the exact content
   fence, and only then writes. A changed HEAD, changed bytes, changed mode, a
   retried different body or an expired preview is refused without touching the
   worktree. Reapplying the same completed operation returns the stored result;
   a device that already observes the confirmed result reports idempotent
   success instead of writing twice.
3. Hunk reverts recompute the working diff deterministically and splice only
   the selected new-side ranges with their old side; unselected hunks cannot be
   smuggled into the operation. Whole-file reverts restore a create's absence or
   the base blob with its reviewed mode.

Writes never touch the index, refs, checkout, branches or remotes: no commit,
no reset, no stash, no force push. Files are written through the pinned parent
descriptor with `O_NOFOLLOW`, an exact stat fence, and `O_EXCL` for creates, so
a concurrent creator is never overwritten. A path that is a symlink, a hardlink,
a device/mount escape, or outside the visible policy is refused. Creates require
an existing directory chain; a checkpoint that would need a new directory is
reported as a conflict instead of being half applied.

The daemon captures the pre-operation bytes only for the operation it just
applied. The server masks that capture, refuses to keep it when masking would
alter content (`undoReason: 'secret'`), when it exceeds the bounds
(`'too_large'`) or when the device could not prove it (`'none'`), and keeps it
for 24 hours. Only the most recent applied operation on that Run/repository is
undoable, one undo claim is allowed at a time, and Undo re-proves every current
`after` state before writing, so it can never revert someone else's later edit.

Checkpoint restore is a dry run first: the server inflates the retained
`git diff --binary` bound to the reviewed checkpoint revision, and the device
runs `git apply --binary --3way` in a throwaway detached worktree. The plan
lists added/modified/deleted/renamed files and per-file conflicts; content,
delete/modify, rename, submodule, binary and unavailable cases are reported as
conflicts. A preview with any conflict is never applied. A clean plan copies
only the exact resulting bytes, after every current file fence has been proved,
and then re-observes HEAD and the whole status. `restorable` is false for
checkpoints whose payload was never retained or was superseded.

A stopped, released or unreachable Run does not fabricate live Git state.
Status and history return `availability: 'offline'`, `frozen: true`, an explicit
`reason` (`machine_unavailable`, `checkout_unavailable`, `no_live_checkout`),
retained facts only -- the Run publication, the checkpoint review revision and
the latest commit snapshot -- and an empty commit list with `nextCursor: null`.
Writes, revert and restore require a live checkout and return
`workspace_machine_unavailable`.

## Resource and file boundaries

| Resource | Bound |
| --- | --- |
| Tracked plus nonignored untracked path inventory | 20,000 distinct paths |
| Path length | 1,024 characters; 255-character entry names |
| Readable individual file | 1 MiB of complete raw bytes |
| Public file content | 256 KiB UTF-8 and at most 2,000 lines per response |
| One context resolution | At most 20 files and 64 KiB selected content |
| Whole-source validation per receipt | 1 MiB decoded aggregate, including all context files |
| Mention IDs per resolve/submit | At most 5, deduplicated in request order |
| Outstanding requests per owner | 8 |
| Device read concurrency | 4 |
| Live request lifetime | 15 seconds |
| Unexpired mentions per owner | 100 |
| Public POST body | 16 KiB before JSON decoding |
| Internal device receipt body | 4 MiB before JSON decoding |
| Git status entries per observation | 5,000; a larger checkout returns `truncated: true` and is read in path order |
| Commits per history page | 50 maximum; `limit` default 30; cursor is bound to the observed HEAD |
| Git read buffer | 8 MiB of porcelain/log output; at most 16 MiB of file bytes are classified per status scan |
| One revertable/restorable file | 1 MiB of observable content; larger files are `workspace_unsupported` or a `binary` conflict |
| Public Git POST body | 32 KiB before JSON decoding |
| Revert preview commitment lifetime | 5 minutes; single use; `previewVersion` is SHA-256 |
| Undo capture | At most 100 files and 1 MiB of masked content; the latest applied operation only |
| Undo retention | 24 hours after the operation applied |
| Checkpoint patch | 2 MiB decoded; inflated only from the Run's retained checkpoint, never from a caller patch |
| Checkpoint plan | 5,000 action entries and 5,000 conflicts |

Git-tracked files and nonignored untracked files are listed. Git ignore rules
apply to untracked files; being tracked does not bypass the protected-path
policy. Dotfiles/directories are opt-in. `.git`, `.env*`, native CLI credential
directories, SSH/cloud credentials, key files, `node_modules` and other
protected paths are excluded even when tracked.

Filesystem reads currently require Linux descriptor traversal. Every segment
uses an already-open directory, `O_NOFOLLOW`, device and mount-ID checks;
regular files must have a single hard link. File metadata, visible path and
HEAD are checked before/after the observation. Other daemon platforms return
`workspace_unsupported` until an equivalent descriptor-safe implementation is
available. There is no fallback that follows unchecked paths.

The private daemon receipt is `{result, files: [{path, base64}]}`. Each unique
text path has exactly one complete-file proof. The server verifies canonical
base64, aggregate size, raw hash, UTF-8, line count and exact selected content,
then applies the existing secret/credential masker to the complete text and
all public metadata. A secret anywhere in a file rejects the observation,
including requests for a seemingly harmless range. Secret values are never
sent to the daemon for this check. Proofs remain in request memory and never
enter the public response, database result, mention, logs or traces.

The result and a private keyed fingerprint of the exact mask inputs/rules are
stored together. Every successful receipt must still match the current policy
when consumed and at the final response or message-commit boundary. A newly
registered multiline secret can span omitted lines or separate selections, so
masking only the returned fragments is insufficient: a changed or missing
policy rejects the old observation and requires a new full-proof read. Derived
mentions carry this evidence only in non-enumerable server-side properties;
neither the fingerprint nor the private receipt identity is serialized.

This protects the Files API. It does not claim that a privileged process on
the same native machine cannot inspect native CLI/Git credentials; #1712 owns
the separate task-Secret exposure boundary.

## Delivery, lifecycle and errors

The existing device work push and PostgreSQL `LISTEN/NOTIFY` carry requests.
Only daemons advertising `x-mikka-coding-workspace: 1` receive them. A pending
HTTP read subscribes before insertion and sends its device wake immediately.
A receipt wakes its waiter and, when necessary, drains the next bounded batch.
Receipt delivery retries a network/5xx failure at most twice, within the
original deadline; authorization errors, rate limiting and conflicts are not
retried. Stopping the daemon aborts delivery. No idle polling is added.

The waiting request consumes/deletes its temporary database result. Crash
residues and expired mention metadata are removed through the existing
reconciliation sweep. New rows use the existing account-deletion write fence
and dynamic owner cleanup. Clients invalidate via the existing Run live key;
`observedAt` describes an observation, not a filesystem watch subscription.

All public responses use `Cache-Control: private, no-store` and
`X-Content-Type-Options: nosniff`.

| Code | HTTP | Meaning |
| --- | --- | --- |
| `authRequired` | 401 | Missing, expired or revoked human session/PAT |
| `workspace_not_found` | 404 | Inaccessible or mismatched Run/Workspace/repository authority; does not disclose foreign existence; see the 403 exception below |
| `workspace_path_unavailable` | 404 | Missing, protected, unsafe or secret-bearing source |
| `workspace_invalid_request` | 400 | Invalid request/schema/range |
| `workspace_limit_exceeded` | 429 | Byte, path, context, concurrency or owner quota exceeded |
| `workspace_unsupported` | 422 | Unsupported source/platform/context format |
| `workspace_machine_unavailable` | 409 | Stopped/offline/released machine, expired active lease or timed-out live delivery |
| `workspace_checkout_unavailable` | 409 | No matching journal checkout or repository |
| `workspace_version_conflict` | 409 | Changed file/HEAD/inventory/machine binding or superseded Run |
| `workspace_request_expired` | 409 | Expired command or mention |
| `workspace_git_revert_conflict` | 409 | The worktree no longer matches the confirmed revert preview |
| `workspace_git_revert_unsupported` | 422 | Rename/copy, submodule, binary or oversized target cannot be reverted this way |
| `workspace_git_restore_conflict` | 409 | The checkpoint plan has conflicts, or the checkout changed since the preview |
| `workspace_git_restore_unavailable` | 422 | No retained, restorable payload for that checkpoint or revision |
| `workspace_git_undo_unavailable` | 409 | No undoable operation, expired capture, already undone or claimed undo |
| `workspace_git_operation_conflict` | 409 | Same operation ID with a different body, or an operation in an unusable state |
| `workspace_git_operation_expired` | 409 | The confirmation token outlived its five-minute window |

Git write failures are never silently retried. A conflict means the checkout
changed; re-read status, re-preview and confirm the new diff. A preview that was
released because the device was unreachable may be retried with the same
operation ID, because the device still re-proves every fence before writing.

Human-inbox submission also preserves the existing action conflict codes.
Do not infer retry authority from a generic 409; use the code and require a
new selection for stale context.

The mentions endpoint returns HTTP 403 with `workspace_not_found` when a
session request is not same-origin or when a PAT attempts `submit`; every
other `workspace_not_found` is 404. The UI may surface this as workspace
unavailable; the person should send from the Mikka app. A mobile BFF is a later
phase, not the current path.

An expired mention is never replayed from a previous submission; the caller
must reselect it. For session requests, deployments behind a reverse proxy must
preserve the public request origin: this endpoint compares `Origin` with the
request URL's origin and does not consult a separately configured application
origin, so a rewritten internal origin is refused as 403. A PAT `create` or
`resolve` does not run this origin check.

## Acceptance records

`packages/daemon/test/coding-workspace-files.test.ts` uses real Git, filesystem
races and a persisted journal. `server-link-workspace.test.ts` checks the HTTP
transport's bounded retries. These are not a production E2B acceptance.

`pnpm test:coding-workspace-db` is enrolled in the complete required PG17
inventory. It runs authority/concurrency/secret tests and a real local TCP API
through `createApiHandler`, the complete daemon and its default `HttpServerLink`.
The latter uses retained fixture code and never starts a model. `REQUIRE_DB=1`
fails when the isolated database is missing; a local skip is not a pass.

Git porcelain/log parsing and the revert evidence/commitment arithmetic are
source-only tests in `pnpm test:coding-workspace-diff`
(`lib/coding-workspace/git/parse.test.ts`, `evidence.test.ts`). The Git
acceptance in `pnpm test:coding-workspace-db`
(`lib/coding-workspace/git/operations.db.test.ts`) runs real PostgreSQL 17,
real Git worktrees and the complete daemon write path: live status/history,
a file revert that survives a retry and is then undone, a rejected apply after
the file or HEAD changed, a hunk-only revert, a clean checkpoint restore with
Undo, a conflicting plan, and the member/stranger/other-tenant/stopped-machine
refusals. Only the device gateway wake is replaced; authority, receipts, CAS,
masking and the filesystem writer stay real.

`Coding Workspace Files acceptance` consumes a successful canonical main E2B
release. Before checkout or smoke credentials it verifies the actual workflow,
repository, SHA and run attempt; the driver rechecks the matching READY Web
deployment and served SHA before and after execution. A relevant change with
no newly validated/published worker is explicitly skipped, never a runtime pass.

The production driver uses the shared smoke member and two ordinary tasks in
`alexj11324/Mikka-handoff`, fixed to Claude Haiku 5.5 and Codex GPT-6 Luna. It
waits for the normal persisted running state and worktree live event, then
records identity, tree/search, a README range, and mention create/resolve through
the public API. A paired native shell input/output independently reads the
actual Git HEAD, README hash/range and root-owned installed worker identity.
No assistant prose, mocked receipt or production configuration value substitutes
for this native evidence. Reports retain hashes, versions, timings and request
counts; they do not retain source text, credentials or absolute worktree paths.

Cleanup uses the existing task/VM end path. Before deleting the owned fixture,
the driver verifies actual machine-end receipts and an ended/no-resource view,
then requires typed rejection of identity, file and old mention access. Normal
end can revoke the device token, yielding `workspace_not_found` (404); a still
authorized but released machine yields `workspace_machine_unavailable` (409).
Neither a generic 404, an auth failure nor a timeout counts as this proof.
An active-window miss or either harness failure remains a failed acceptance;
the driver does not launch replacement model turns. It currently uses a real
authorized Team task: canonical Shared No-Team coverage remains dependent on
the domain-owner integration and is not claimed by this harness.

Record final PR head, CI run, merge SHA, Web READY/served SHA, real E2B source
read/reference evidence and remaining platform/canonical-integration gaps on
#1721. Keep #1720 open until all its backend and UI scenarios are accepted.
