# Agents and Bots read and message each other (S7)

- Date: 2026-11-19 22:00 UTC
- Source: Alex, 2026-11-19 — "Agent 和 Bot 都应该能读取其他 Agent 和 Bot 上的各种内容；
  不做前端，但后端能力、接口、API 都要有并且能用；读取、发送、发消息唤醒都要做。"
  Plan section S7 and "Drive 的定位" of the Capy alignment plan.
- Scope: backend, tools and `/api/v1` only. No page, panel or setting is added.

## 1. Who is asking: one principal type

Every read or send in this slice names an **interop principal**:

| Principal | Where it comes from | Owner identity | Its own ACL subject |
|---|---|---|---|
| `account` | a PAT on `/api/v1` | the token's user | — |
| `bot` | an EVE Bot tool call | the Bot's owner | `('bot', botId)` |
| `run` | an Agent worker MCP call (run token) | the run's owner | `('run', runId)` |
| `service` | an `mksvc_` service key on `/api/v1` | none | `('service', identityId)` |

A principal is pinned to exactly one Workspace: the token's, the Bot's, the
run's or the service identity's. That tenant is passed to
`mikka_resource_acl_allowed`, which already refuses any resource whose policy
names another tenant. **Cross-tenant access is therefore always denied**, with
no grant able to widen it.

The decision for a target resource is

```
owner is an active member of the tenant (fresh Workspace/Enterprise check)
AND ( acl('account', owner, …) OR acl(subjectKind, subjectId, …) )
```

for `bot` and `run`; `account` uses only the first term and `service` only the
second (a service has no owner and no membership). Tools still execute as the
owner ("工具执行仍用 owner 身份"), but the owner identity is never a bypass:
the target object must pass the ACL above.

`resource_access_grants."subjectKind"` gains `bot` and `run`. A `bot`/`run`
subject is authorized **only by an explicit grant** — the ownership and
`shared` visibility shortcuts stay `account`-only, so granting a Bot access to a
thread never also exposes it to every teammate, and no Bot inherits anything by
existing. Reads ask `canReadContent`; sends ask `canSteer`.

## 2. Reading

- `read_thread_messages(runId)`: the thread (root run and its continuations)
  — per attempt its status, summary, the messages sent to it and the last
  agent events. A teammate's ordinary run view still never carries a transcript;
  this tool returns content only after `canReadContent` on the thread.
- `read_run_diff(runId)`: the thread's retained checkpoint patch (the same
  bytes the continuation flow restores). It is masked with the owner's Secret
  masker and refused if masking would change it, as the live diff route does.
  The live machine diff (`/api/runs/[runId]/workspace/diff`) stays a
  human-session surface: it needs a review credential and a device round trip.
- `list_artifacts` / `read_artifact`: tenant-filtered and ACL-checked per row.
- `read_bot_chat(botId)`: the last N messages of the owner's chat with that Bot
  (`chat` resource). Text parts only; tool payloads are omitted.
- `list_runs` / `get_run` are added to the Agent worker MCP with the same
  projection the Bot already gets.

## 3. Sending and waking

- `send_to_thread(runId, text, delivery)` wraps `sendThreadMessage` as the
  **thread owner**, source `peer`. `delivery` is `queue` (default) or `steer`.
  An ended thread continues in the same thread (the existing continuation path
  with its admission, machine and quota checks). A stable idempotency key is
  required, so a retried tool call never starts two continuations.
- `send_to_bot(botId, text)` writes a `run_report` coordinator event into the
  Bot owner's chat (payload `source: 'peer'`, sender kind and id) with tier
  `result`, then calls `wakeCoordinator`. Peer text is never a human request:
  it is the same event kind the OAuth agent path uses, and Factory intake still
  refuses it. `result` (not `attention`) starts a turn without paging anyone.
- Mailbox: a message to a mailbox whose run has ended continues that thread
  through `send_to_thread` instead of failing.

## 4. Drive

Drive is a shared folder per scope, not a per-agent store. Two scopes are
added to `DRIVE_SCOPES`: `bot` (scope id = botId) and `thread` (scope id = the
thread's root run). `environment` (scope id = environmentId) is added for files
every run of an Environment shares. The plan's `workspace` scope **is the
existing `team-workspace`**: the contract deliberately keeps the word
`workspace` for the tenant, so tools and `/api/v1` accept `workspace` as an
alias and store `team-workspace`.

| Scope | Read needs | Write needs |
|---|---|---|
| `bot` | `canReadContent` on the bot | `canSteer` on the bot |
| `thread` | `canReadContent` on the thread | `canSteer` on the thread |
| `environment` | tenant member, Environment in tenant | same |
| `team-workspace` | tenant member of a team Workspace | same |

Writes keep Drive's CAS: `expectedDigest` must be the head the writer read, and
a mismatch returns `drive_version_conflict` with the conflicting paths. A
writer re-reads and merges; nothing is overwritten silently. Machine sync
(`~/.mikka/drive/<scope>/`) uses the same version contract.

## 5. External API

`/api/v1/threads`, `/api/v1/threads/{runId}/messages` (GET, POST),
`/api/v1/artifacts`, `/api/v1/artifacts/{id}`, `/api/v1/drive/volumes`,
`/api/v1/drive/volumes/{id}/files` (GET, PUT), `/api/v1/bots`,
`/api/v1/bots/{botId}/messages` (GET, POST).

New PAT scopes: `threads:read`, `threads:write`, `artifacts:read`,
`drive:read`, `drive:write`, `bots:read`, `bots:write`. An `mksvc_` key is
admitted on exactly these routes; it authenticates the service principal and is
authorized only by its explicit grants. It never becomes a human session and
cannot reach any other route.

## 6. Boundaries kept

- No Secret value, credential or machine authority moves with a read or a send
  (credential-exposure boundary, 2026-11-08-0240). A Drive file is content, not
  a Secret channel.
- The execution boundary stays the machine: a send continues the target's own
  thread on its own machine with its owner's admission.
- No polling is added; waking uses the existing outbox and `wakeCoordinator`.
