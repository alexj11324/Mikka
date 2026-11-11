# Coding Workspace Task review API

Use this reference to connect the Web, hosted and iOS review surfaces to the
Task adapters. See [Run review API](coding-workspace-review-api.md) for the
underlying source, local board and native GitHub thread endpoints.

Backend ownership: #1721 / #1722. UI ownership: #1731–#1735. These adapters
reuse the Run workspace source, review board, GitHub operation ledger and
Factory merge ledger. They do not introduce another execution or merge state
machine. The approved layout is decision `2026-11-08-1230-coding-workspace`.

## Identity and permissions

All Task endpoints use `/api/tasks/:taskId/review`. A session may select
`workspaceId`; a personal access token remains pinned to its own Workspace.
Task visibility, active membership and the frozen Run/Repo/Workspace binding
are checked independently. The persisted Task owner selects the newest task
thread; the viewer's thread, group chats, Factory review/verify/monitor runs
and a Bot's current repository never select the source.

Sending to the Agent and merging require the Task owner's real session.
Native iOS sessions use the existing mobile origin policy. Cross-site browser
writes are refused. A PAT cannot become a human GitHub writer. Native GitHub
reads and writes use the viewing/writing person's connection, never the Task
owner's credential on behalf of a teammate or an installation token posing as
a human. A teammate can keep independent local Reviewed marks.

`permissions` describes an action, not a machine lease. Terminal/preview
eligibility and revocation are owned by #1723/#1724. Every action still
revalidates its actual authority; a previous summary is not an authorization.

## References and reads

```ts
type ReviewRef = { snapshotId: string; sourceVersion: string }
```

`sourceVersion` is the complete immutable source fingerprint, not HEAD. Dirty
working trees can have the same HEAD and different versions. Clients must keep
both reference fields through opening a file, adding comments, attaching
checks, pagination and retry. Never silently re-anchor comments after refresh.

| Method and suffix | Input | Result |
| --- | --- | --- |
| `GET /` | Optional `workspaceId`, reference pair, `cursor`, `limit` 1–100, `unreviewed=true/false`, or `commit` | `{summary, diff}` or `null` when the Task has no coding Run |
| `GET /summary` | Optional `workspaceId` | Whole-Task summary or `null` |
| `GET /file` | `snapshotId`, `sourceVersion`, `path`, optional comments `cursor` | `{reviewRef, file, comments, nextCommentsCursor?}` |
| `GET /checks` | `snapshotId`, `sourceVersion` | Complete native observation, or explicit `not_applicable` |
| `POST /reviewed` | `reviewRef`, `expectedRevision`, `idempotencyKey`, `files: [{path,fileVersion,reviewed}]` | Original board mutation receipt and `reviewRef` |

The file cursor is opaque and carries its exact reference and unread filter.
Do not combine a cursor with a commit filter. A commit filter requires a
reference with a known base and a full commit SHA; its range is the selected
review's base through that commit. It changes the displayed diff, not the
whole-Task summary or merge target. `diff.boardRevision` is the optimistic
concurrency value for Reviewed mutations. A stale board revision returns
`workspace_review_conflict`; reread before creating a new intent.

Summary counts and checks are nullable. `countsKnown=false` does not mean zero
changes. `reviewRef=null` means there is no available source to comment on.
File `format` distinguishes `unloaded`, `text`, `binary`, `too_large` and
`unavailable`; file `status` can also be `unavailable`. Base/HEAD may be null.
Source records its actual kind, observation time, staleness and reclamation.
Only a fresh, available working-tree read from a running machine is `live`.
A retained working snapshot shared with a teammate is historical evidence.

Sent inline comments come only from accepted Agent batches with this exact
snapshot and source version. The mutable board, a draft and a separately
accepted GitHub review cannot fabricate an Agent-delivered comment. Comments
are paginated at 100. Full board threads, replies, resolution, outdated state,
audit receipts and native GitHub threads remain available on the existing Run
API at `/api/runs/:runId/workspace/diff/:snapshotId/{review,github-review}` with
the explicit `repoId` and Workspace context.

Task list/detail reads embed `task.review`; citations embed issue `review` or
`source.issue.review`. This is a bulk local metadata projection. It neither
contacts every machine/GitHub repository nor creates a source snapshot on a
list read. A first coding Run can therefore have an entry with unknown counts.
No source body or check log is included in these cards.
Mobile task list/detail reads use `review: null` when no summary exists.
Citations keep their existing shape by omitting `review` in that case; readers
should treat an absent property and null as no summary. The source-selection
hint stays private and never authorizes a source or an action.

## Checks and current PR state

`GET /checks` returns an object, not an array:

```ts
type CheckRead = {
  reviewRef: ReviewRef
  state: 'complete'
  observationId: string
  observedAt: string
  headSha: string
  fingerprint: string
  counts: { total: number; failed: number; passed: number; pending: number; neutral: number }
  checks: Array<{
    id: string; name: string; nameTruncated: boolean
    status: 'failed' | 'passed' | 'pending' | 'neutral'
    conclusion: string | null; logExcerpt: string; logTruncated: boolean
  }>
}
```

Native check runs and latest commit statuses are both read, with complete
bounded pagination. `neutral`/`skipped` is separate from `passed`. Incomplete,
malformed or over-budget provider results are refused. Each check ID is an
opaque server observation reference; attachments submit IDs, never client log
text. Excerpts are masked before truncation and include `logTruncated`.

PR state uses GitHub's current `reviewDecision` alongside open/closed/merged,
so an old accepted request-changes batch does not masquerade as current state
after dismissal. The immutable diff is never rewritten to store that state.
Cards use the viewer's last observed metadata and expose its time.

## Send one review

`POST /send` accepts:

```ts
type Submission = {
  reviewRef: ReviewRef
  comments: Array<{ path: string; line: number; side: 'old' | 'new'; body: string }>
  note?: string
  attachedChecks: string[]
  idempotencyKey: string
}
```

Do not send client-only comment IDs. At most 50 line comments, 100 check refs,
4,000 characters per comment/note, and the existing complete Agent/native
batch bounds apply. Oversized feedback is refused before effects, not silently
truncated. One reference binds the whole batch.

Local comments, the Agent batch, the optional GitHub `REQUEST_CHANGES` batch
and their parent request receipt commit atomically before any external write.
GitHub is delivered first for a PR; an unknown or rejected native write does
not dispatch the Agent. Delivery reuses the established ledgers and the
current Factory/ordinary continuation path.

| HTTP | `state` | Meaning |
| --- | --- | --- |
| 200 | `sent` | Both required deliveries accepted; actual `messageId` and one-based `attempt` are present |
| 202 | `pending` | At least one result is not yet known; preserve the exact request |
| 409 | `partial` | GitHub accepted, Agent refused; both durable receipts are returned |
| 409 | `blocked` / `rejected` | The action cannot proceed; inspect the returned receipts/error |
| 403 | When a batch exists, `rejected` / `blocked` | `github_permission`; owner/session refusals can return only `error` and `reason` |

An exact retry uses the original key and payload. The same key with a changed
payload is rejected. Equivalent reordered submissions join the existing
accepted/uncertain plan. An unknown GitHub write is reconciled only with a
complete positive native receipt, never another POST. The display message and
accepted delivery share the original queue transaction.

## Approve and merge

Summary `mergeTarget` is null or:

```ts
type MergeTarget = {
  reviewRef: ReviewRef
  binding: {
    taskId: string; issueId: string; attemptId: string
    revision: number; candidateId: string
  }
  expectedHeadSha: string
}
```

`POST /merge` submits that exact target plus `idempotencyKey` and
`confirmFailedChecks`. With a failed check the 409 `needs_confirm` response
includes `checksFingerprint`; confirmation submits it as
`confirmedChecksFingerprint`. Keep the original target and check evidence.
Confirmation is a new explicit intent; use a new key, then preserve that exact
confirmed request for transport retries. `newIntentRequired=true` explicitly
signals that a previously claimed attempt was refused before its PUT.

Pending checks block merging. A changed candidate, head, base, Factory binding
or check fingerprint invalidates confirmation. The checks and authority are
revalidated immediately before the existing Factory merge invocation, after
its durable claim committed. A lost response remains 202 `pending`; retry
reads the original ledger and never makes another PUT. Only HTTP 200 with
`state=merged` and `reviewedHeadMerged=true` proves the reviewed commit merged.
An external merge of a different HEAD is `merged_elsewhere` with HTTP 409.

## Invalidation and lifecycle

Use the existing Task-scoped live keys `issue_threads`, `pull_request_status`
and `factory_issue`, all keyed by the issue UUID in `summary.live.workspaceId`.
After a local action, invalidate that Task's existing review keys. The App's
already subscribed review/review-comment webhooks only invalidate delivered
PR metadata; their bodies never become approval or merge state. This change
does not enable check-run/check-suite/workflow subscriptions or add polling.

Session/PAT/Workspace/task access is checked again at final serialization and
before effects. Physical machine cleanup does not remove retained safe review
evidence. A newly unavailable checkpoint supersedes an older usable one.
Expired or superseded machine authority is never reconstructed from a Task's
newest repository or from a convenient current Bot.

Errors use the existing `workspace_*` / `workspace_review_*` codes, plus the
public owner/GitHub denial reasons and the explicit confirmation response.
Clients must distinguish 202 unknown from 200 accepted and must not clear a
pending review merely because a network request returned.
