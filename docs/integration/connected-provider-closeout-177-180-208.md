# Connected-provider closeout: #177, #180, #208

Recorded 2026-10-31 UTC. Scope is the existing older issues, with AGENTS.md's
default-on rule and existing authorization, account, KMS and execution fences.
Implementation tests used no live credentials. The later authorized read-only
resource preflight below used dedicated credentials only in process memory.
No OAuth grant, IAM resource or live external message was created or changed.

## Fixed code and risk evidence

Base: `375d670937ca06c53e47f336870481d38520c1fe`.
Product revision tested: `963ec007dbc24c1645a8886278493df7bbd89553`, branch
`codex/old-provider-closeout`, cloud Linux. Commits, in dependency order:

- `22e068bbf2cbf7384a4202097fffc7607258c384`: default-on approved writes and
  credential vault, including the owner-bound chat secret scan. Explicit incident
  kill switches remain; authentication, policy, target and KMS checks remain.
- `e0a599eb8619dd32dde34dfeaa1b3556774ac286`: dispatched legacy Gmail/Calendar
  errors retain `running/operationUncertain`; preflight failures remain failures.
  The consumed proposal is never reset to pending. The Coordinator is told to
  read back, with no success/failure assertion and no blind resend.
- `081e933115799d4e03f6021e269b497d168bc301`: Slack metadata correlation and
  account-pinned readback through the existing Composio proxy. New writes pin
  `slack-message-metadata-v1`; old native writes without metadata remain uncertain.
- `963ec007dbc24c1645a8886278493df7bbd89553`: actual object ID and optional
  provider permalink reach tool results and authenticated views. Human decisions
  reuse `action_decided` and the existing Coordinator wake, routed to the original
  Bot. Unknown and verified states have separate dedupe keys.

Observed defects, occurrence × impact (1–10): default-off completed entry points
10×6; a lost response misreported as failed after an irreversible write 5×8;
Slack's unconditional null lookup 7×8; successful human approvals without a
receipt/result notification 10×5. These are ordinary execution paths or explicit
issue requirements. No speculative edge-case framework was added.

## Per-issue acceptance status

| Issue | Existing implementation and completed delta | Remaining acceptance; closure status |
| --- | --- | --- |
| [#177](https://github.com/alexj11324/Mikka/issues/177) | Existing connected-account reads, email send and Calendar list/create/update with CAS approval and frozen account; Notion append, Slack send and conditional Calendar cancel are admitted by default. Lost-response errors are honest. New ledger results include actual IDs; Slack obtains its real permalink with `chat.getPermalink`. Human decisions notify the original Bot. | The four paths still require one fixed actual Mikka application, automatic leased app identities, authorized nonproduction provider accounts and controlled targets, normal approval/denial/expiry checks, independent SaaS readback and UI evidence. This run does not satisfy those live checks; do not close from these fixtures. The email requirement does not require inventing a new threaded-reply tool. |
| [#180](https://github.com/alexj11324/Mikka/issues/180) | Existing separate app/broker KMS roles, encrypted DB envelopes, owner/origin bindings, one-use leases and hidden browser entry were retained. Default admission and default chat fingerprint scanning now follow AGENTS.md. | #180 comments contain earlier real Preview/KMS/E2B evidence at earlier SHAs. It is historical, not current-head acceptance. The fixed current Mikka app/broker, authorized browser target, model/login continuation and runtime secret/telemetry scans still need their matching live verification. No current cloud configuration values or account availability were assumed. Do not close from pure crypto/guard tests. |
| [#208](https://github.com/alexj11324/Mikka/issues/208) | Reuses the existing ledger/invocation gate, stable operation intent, approved payload/account/run binding and current policy/session checks. Previously merged human readback after worker failure is preserved. Slack now has precise metadata readback instead of unconditional null. Ten callers make one effect; payload conflicts and unauthorized new-run approval inheritance are rejected. | The issue explicitly requires at least one authorized real nonproduction provider path in actual Mikka, including provider success before receipt writeback failure and independent readback. This run verifies the actual Slack adapter over an HTTP protocol fixture, not Composio/Slack SaaS. Historical uncorrelated writes, Notion and Calendar cancellation retain uncertain when no reliable attribution exists. No universal exactly-once claim or new-run approval inheritance is made. Keep open until the applicable live gate passes. |

## Reproducible backend evidence

Final product checks completed 2026-10-31 01:45–01:48 UTC. All commands exited 0:

| Check | Result | Retained local log |
| --- | --- | --- |
| `pnpm test:approved-writes` | 74/74, no skips | `/tmp/mikka-write-notice-approved.log` |
| `node --import tsx --test lib/operations/write-notice.test.ts lib/operations/slack-delivery.test.ts` | 6/6 | `/tmp/mikka-provider-final-unit.log` |
| Related view/discovery/new-adapter tests | 14/14 | `/tmp/mikka-write-notice-unit.log` |
| `pnpm exec tsgo --noEmit` | pass | `/tmp/mikka-write-notice-types.log` |
| Targeted oxlint and `git diff --check` | pass | command exit 0 |
| Real-PG recovery, generic and actual Slack adapter | 4/4, no skips | `/tmp/mikka-write-notice-db.log` |

Earlier affected checks on their corresponding code commits also passed:
`test:credentials` 37+7, default-on chat guard 3, personal-message-safety 21+10,
legacy unknown/provider/context tests 29, and pending-account binding 5.
Logs are `/tmp/mikka-provider-defaults-{credentials,safety}.log` and
`/tmp/mikka-provider-unknown-{unit,binding}.log`.

PG17 is the retained local container at `127.0.0.1:55599`; the new owned database
is `mikka_provider_closeout_e2e`. No old database or schema was deleted.
The three application/DB test URLs matched exactly:

```sh
E2E_DATABASE_URL=postgres://postgres@127.0.0.1:55599/mikka_provider_closeout_e2e \
DATABASE_URL=postgres://postgres@127.0.0.1:55599/mikka_provider_closeout_e2e \
MIKKA_DATABASE_URL=postgres://postgres@127.0.0.1:55599/mikka_provider_closeout_e2e \
REQUIRE_DB=1 node --import ./scripts/server-test.mjs --import tsx \
  --test --test-concurrency=1 lib/operations/recovery.db.test.ts
```

Final retained schemas are `operation208_474f307e84dc439294a1f0c342d728bd`,
`operation208_a3858b140aa24646af7a8997624c216e`,
`operation208_df16c122529545e8b7f6550c038405fa`, and
`operation208_9be8e9cfeeb84282b53bc90019aa3a22`. Independent HTTP receivers ran
on loopback ports 40585, 46507, 42275 and 37129; only these owned child processes
were terminated at test completion. The receiver deliberately does not dedupe
POSTs. The test applies an effect, signals the parent, then SIGKILLs its worker
before receipt writeback. Recovery after the execution is marked failed uses
current owner/session/policy authorization and reads the receiver without a
second POST. The Slack variant verifies real adapter metadata, receipt and
permalink propagation; every test asserts `posts=1,effects=1`.

These fixture identities and receivers are not normal application accounts or
live provider resources. No application browser, real OAuth flow, current-head
Git-linked CI, production deployment or SaaS acceptance was claimed by this run.
The integrating parent records those separately at the final merged revision.

## Authorized read-only resource preflight

2026-10-31 01:55–01:56 UTC, using the already configured Infisical Universal Auth
identity. Login returned 200. Only the dedicated email/password keys in
`Mikka Test Account Vault` / `dev:/test-account` and the Mikka
`prod:/vercel/COMPOSIO_API_KEY` were fetched individually. Values and cookies
remained in memory; no environment file or browser session file was written.

- The provided frozen Production origin
  `https://mikka-o70hhdy9f-mikka-dev.vercel.app`, associated by the parent with
  `375d670937ca06c53e47f336870481d38520c1fe`, rejected sign-in with 401. A separate
  unauthenticated GET returned a 302 Vercel authentication redirect. Neither
  redirect was followed; no protection or application guard was bypassed.
- On `https://app.aspectlylabs.com/mikka`, normal email/password sign-in returned
  200, `get-session` returned 200, and the actual session matched the dedicated
  identity with `emailVerified=true`. Normal same-origin sign-out returned 200.
  The canonical domain is a moving deployment, so this does not replace fixed
  current-head application acceptance.
- Composio SDK listing used exactly that verified application user ID and
  `accountType:PRIVATE`, without status filtering. One complete page contained
  only **Slack** and **Notion** connections, both `ACTIVE`, enabled, with enabled
  auth configurations. There were no Gmail or Calendar connections for this
  dedicated identity.
- Private connection metadata does not identify or authorize an acceptance
  channel, page or recipient. No specific controlled target was established from
  the permitted sources. No workspace content, other owner's connections, Slack
  messages, Notion pages or mailbox contents were read. External writes: **0**.

The locally retained sanitized log is `/tmp/mikka-provider-preflight-safe.log`;
the parent received the exact dedicated user/connection IDs and request IDs
privately. Do not publish account details or internal traces from that log.
The preflight script is source-only at `/tmp/mikka-provider-preflight.mjs`.
Node needed `--use-env-proxy` to honor the existing managed network path;
direct Node fetch failed with ECONNREFUSED before any application login.

Remaining resource gates are a fixed admitted application after integration,
explicit controlled Slack/Notion targets, and authorized Gmail/Calendar linking
for the two absent connections. No linking or external write was attempted.

## Provider contract references

Official documentation checked 2026-10-31:
[message metadata](https://docs.slack.dev/messaging/message-metadata/),
[chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage/),
[conversations.history](https://docs.slack.dev/reference/methods/conversations.history/),
[chat.getPermalink](https://docs.slack.dev/reference/methods/chat.getPermalink/).
The writer sends only a correlation key and approved-payload digest in metadata;
it sends no owner ID, account ID or secret in metadata. Readback requests
`include_all_metadata=true` and requires the exact operation key and payload
digest. Text equality alone is never evidence. Provider errors, missing metadata
or unavailable history preserve uncertainty and do not authorize another write.
