# Phase 2 public source coverage

Source commit [`6890ed6fb3d4751addc94baeb21e745c15ca4137`](https://github.com/alexj11324/Mikka/tree/6890ed6fb3d4751addc94baeb21e745c15ca4137). The initial inventory anchored at `75fd0b44` preceded the delivery merges. This snapshot indexes 7,948 tracked paths, 317 registered routes and 422 method registrations. All paths in this inventory belong to the public repository.

[Download the machine-readable file and consumer inventory](source-inventory.json.gz). After decompression, `files` contains one record per tracked path. Incoming and outgoing edges cover resolvable source references from the repository’s own `scripts/ci/graph.mjs`, including file references outside JavaScript imports. `entries` lists line numbers for conventional entrypoint names. `calls` lists syntactic call names, which may resolve differently at runtime. `unresolved` identifies dynamic reads needing manual confirmation. `similar_groups` contains normalized TypeScript AST bodies of at least 60 nodes shared between files. A match is a lead, not a disposition.

Normalized AST scan: 3,838 production/tool JS and TS files after excluding fixtures, tests, generated, dist and vendor directories; 3,199 named entrypoints; 84 similarity groups. The file graph also includes tracked tests and non-JS files. Dependency graph source-source edges: 76,852. Unresolved references: 128. Uncompressed JSON SHA-256: `354ee16f0b795111668155168d0fec6cdc77d6de617d31be4443cd87d3a851f4`.

## Evidence and scope

Source areas listed below have structural coverage. Only cases explicitly recorded in [the delivery ledger](https://github.com/alexj11324/Mikka/issues/2300) have behavioral or runtime evidence. Cross-repository calls, runtime dispatch, deployment selection and tenant isolation require separate review. Private evidence is recorded in its owning repository.

| Range | Tracked paths | AST files | Registered routes | Unresolved references |
| --- | ---: | ---: | ---: | ---: |
| (repository root) | 35 | 7 | 0 | 0 |
| .agents | 9 | 0 | 0 | 0 |
| .claude | 298 | 0 | 0 | 0 |
| .github | 60 | 0 | 0 | 0 |
| agents | 5 | 0 | 0 | 0 |
| app | 384 | 356 | 315 | 0 |
| apps/api | 78 | 47 | 2 | 10 |
| apps/desktop | 210 | 75 | 0 | 9 |
| apps/eve | 19 | 17 | 0 | 0 |
| apps/frontend | 27 | 16 | 0 | 5 |
| apps/mobile | 463 | 375 | 0 | 1 |
| cloudflare | 1 | 1 | 0 | 0 |
| cloudflare/api | 10 | 7 | 0 | 1 |
| cloudflare/credential-broker | 2 | 1 | 0 | 0 |
| cloudflare/credential-identity | 5 | 3 | 0 | 0 |
| cloudflare/device-gateway | 10 | 4 | 0 | 0 |
| cloudflare/engineering-sandbox | 11 | 3 | 0 | 0 |
| cloudflare/eve-runtime | 18 | 6 | 0 | 0 |
| cloudflare/linear-sync | 3 | 1 | 0 | 0 |
| cloudflare/suggestions-cron | 3 | 1 | 0 | 0 |
| cloudflare/task-sandbox | 25 | 11 | 0 | 0 |
| cloudflare/web | 5 | 5 | 0 | 0 |
| cloudflare/workers-ai | 2 | 2 | 0 | 0 |
| components | 23 | 23 | 0 | 0 |
| components/agents | 26 | 25 | 0 | 0 |
| components/ai-elements | 5 | 5 | 0 | 0 |
| components/app-shell | 1 | 1 | 0 | 0 |
| components/artifacts | 12 | 10 | 0 | 0 |
| components/auth | 8 | 7 | 0 | 0 |
| components/billing | 5 | 5 | 0 | 0 |
| components/blocks | 106 | 104 | 0 | 0 |
| components/brand | 1 | 1 | 0 | 0 |
| components/browser | 4 | 3 | 0 | 0 |
| components/chat | 9 | 7 | 0 | 0 |
| components/computer | 6 | 6 | 0 | 0 |
| components/coordinator | 32 | 25 | 0 | 0 |
| components/credentials | 2 | 2 | 0 | 0 |
| components/desktop | 2 | 2 | 0 | 0 |
| components/devices | 9 | 8 | 0 | 0 |
| components/examples | 1 | 1 | 0 | 0 |
| components/icons | 3 | 3 | 0 | 0 |
| components/labels | 3 | 3 | 0 | 0 |
| components/motion | 57 | 57 | 0 | 0 |
| components/nav | 29 | 23 | 0 | 0 |
| components/onboarding | 1 | 1 | 0 | 0 |
| components/plugins | 14 | 10 | 0 | 0 |
| components/reui | 15 | 15 | 0 | 0 |
| components/settings | 54 | 48 | 0 | 0 |
| components/slots | 103 | 102 | 0 | 0 |
| components/suggestions | 3 | 2 | 0 | 0 |
| components/teams | 5 | 5 | 0 | 0 |
| components/ui | 78 | 78 | 0 | 0 |
| components/workspace | 122 | 104 | 0 | 2 |
| config | 3 | 0 | 0 | 0 |
| docs | 932 | 0 | 0 | 1 |
| drizzle | 340 | 0 | 0 | 0 |
| hooks | 74 | 61 | 0 | 0 |
| i18n | 4 | 4 | 0 | 0 |
| lib | 2450 | 1543 | 0 | 13 |
| messages | 2 | 0 | 0 | 0 |
| packages/config | 5 | 2 | 0 | 0 |
| packages/daemon | 364 | 153 | 0 | 11 |
| packages/eve-cloudflare-world | 30 | 18 | 0 | 0 |
| packages/protocol | 110 | 76 | 0 | 0 |
| packages/subscription-worker | 70 | 1 | 0 | 0 |
| patches | 4 | 0 | 0 | 0 |
| public | 20 | 0 | 0 | 0 |
| scripts | 222 | 116 | 0 | 18 |
| scripts/acceptance | 123 | 66 | 0 | 31 |
| scripts/ci | 24 | 10 | 0 | 0 |
| scripts/community-settings-ui | 6 | 4 | 0 | 1 |
| scripts/demo-data | 13 | 10 | 0 | 1 |
| scripts/dev | 2 | 0 | 0 | 0 |
| scripts/dev-local | 34 | 24 | 0 | 0 |
| scripts/device-gateway | 3 | 2 | 0 | 0 |
| scripts/e2b | 63 | 17 | 0 | 2 |
| scripts/ops | 68 | 33 | 0 | 1 |
| scripts/personal-mailbox-acceptance | 2 | 1 | 0 | 1 |
| scripts/release | 24 | 12 | 0 | 0 |
| scripts/self-hosting-ui | 10 | 6 | 0 | 1 |
| scripts/suggestions-cron | 2 | 1 | 0 | 0 |
| scripts/test-accounts | 33 | 21 | 0 | 1 |
| services | 12 | 6 | 0 | 4 |
| tasks | 1 | 0 | 0 | 0 |
| tests | 441 | 0 | 0 | 14 |
| types | 3 | 3 | 0 | 0 |
| workflows | 32 | 24 | 0 | 0 |

## Registered product routes

| Methods | Route | Source |
| --- | --- | --- |
| GET, OPTIONS | `/.well-known/oauth-authorization-server` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/.well-known/oauth-authorization-server/route.ts) |
| GET, OPTIONS | `/.well-known/oauth-protected-resource` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/.well-known/oauth-protected-resource/route.ts) |
| GET | `/api/acceptance` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/acceptance/route.ts) |
| DELETE, GET, POST | `/api/account/deletion` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/account/deletion/route.ts) |
| GET | `/api/account/export/[token]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/account/export/[token]/route.ts) |
| GET | `/api/agent` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/agent/route.ts) |
| POST | `/api/agent-cli-policy` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/agent-cli-policy/route.ts) |
| GET | `/api/agent/images` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/agent/images/route.ts) |
| GET | `/api/agent/sessions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/agent/sessions/route.ts) |
| GET | `/api/agent/sessions/active` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/agent/sessions/active/route.ts) |
| GET, OPTIONS, POST | `/api/agents/[...path]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/agents/[...path]/route.ts) |
| GET, POST | `/api/approved-writes` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/approved-writes/route.ts) |
| GET | `/api/artifacts/shared/[token]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/artifacts/shared/[token]/route.ts) |
| GET | `/api/artifacts/shared/[token]/frame` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/artifacts/shared/[token]/frame/route.ts) |
| GET | `/api/artifacts/[artifactId]/versions/[version]/download` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/artifacts/[artifactId]/versions/[version]/download/route.ts) |
| GET | `/api/artifacts/[artifactId]/versions/[version]/frame` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/artifacts/[artifactId]/versions/[version]/frame/route.ts) |
| GET, POST | `/api/auth/[...all]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/auth/[...all]/route.ts) |
| GET | `/api/avatars/[userId]/[hash]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/avatars/[userId]/[hash]/route.ts) |
| POST | `/api/billing/stripe` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/billing/stripe/route.ts) |
| GET, POST | `/api/bots` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/route.ts) |
| GET, PATCH | `/api/bots/[botId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/route.ts) |
| GET | `/api/bots/[botId]/app-tools` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/app-tools/route.ts) |
| GET | `/api/bots/[botId]/computer` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/route.ts) |
| POST | `/api/bots/[botId]/computer/handback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/handback/route.ts) |
| POST | `/api/bots/[botId]/computer/runs` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/runs/route.ts) |
| GET | `/api/bots/[botId]/computer/runtimes` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/runtimes/route.ts) |
| POST | `/api/bots/[botId]/computer/subscription` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/subscription/route.ts) |
| POST | `/api/bots/[botId]/computer/takeover` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/takeover/route.ts) |
| POST | `/api/bots/[botId]/computer/viewer` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/viewer/route.ts) |
| POST | `/api/bots/[botId]/computer/wake` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/computer/wake/route.ts) |
| GET, POST | `/api/bots/[botId]/definition` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/definition/route.ts) |
| POST | `/api/bots/[botId]/subagents` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/subagents/route.ts) |
| GET | `/api/bots/[botId]/subagents/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/subagents/[id]/route.ts) |
| POST | `/api/bots/[botId]/subagents/[id]/credentials` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/subagents/[id]/credentials/route.ts) |
| POST | `/api/bots/[botId]/subagents/[id]/credentials/challenge` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/subagents/[id]/credentials/challenge/route.ts) |
| POST | `/api/bots/[botId]/subagents/[id]/credentials/login` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/subagents/[id]/credentials/login/route.ts) |
| POST | `/api/bots/[botId]/subagents/[id]/stop` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/subagents/[id]/stop/route.ts) |
| POST | `/api/bots/[botId]/subagents/[id]/viewer` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/bots/[botId]/subagents/[id]/viewer/route.ts) |
| GET | `/api/captures/shared/[token]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/captures/shared/[token]/route.ts) |
| GET | `/api/captures/[captureId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/captures/[captureId]/route.ts) |
| POST | `/api/chat/attachments` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/chat/attachments/route.ts) |
| DELETE, GET | `/api/chat/attachments/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/chat/attachments/[id]/route.ts) |
| GET | `/api/cloud/callback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cloud/callback/route.ts) |
| POST | `/api/cloud/connect` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cloud/connect/route.ts) |
| POST | `/api/cloud/disconnect` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cloud/disconnect/route.ts) |
| GET | `/api/cloud/models/billing` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cloud/models/billing/route.ts) |
| GET | `/api/cloud/status` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cloud/status/route.ts) |
| POST | `/api/cloud/webhooks/github` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cloud/webhooks/github/route.ts) |
| POST | `/api/computer/approvals/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/computer/approvals/[id]/route.ts) |
| GET | `/api/computer/events` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/computer/events/route.ts) |
| GET | `/api/conversation-links/[id]/messages` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversation-links/[id]/messages/route.ts) |
| GET, POST | `/api/conversations` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/route.ts) |
| PATCH | `/api/conversations/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/[id]/route.ts) |
| GET, POST | `/api/conversations/[id]/decisions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/[id]/decisions/route.ts) |
| POST | `/api/conversations/[id]/decisions/replay` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/[id]/decisions/replay/route.ts) |
| DELETE, GET, POST | `/api/conversations/[id]/members` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/[id]/members/route.ts) |
| GET, POST | `/api/conversations/[id]/messages` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/[id]/messages/route.ts) |
| GET, POST | `/api/conversations/[id]/read` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/[id]/read/route.ts) |
| POST | `/api/conversations/[id]/stop` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/conversations/[id]/stop/route.ts) |
| GET, PUT | `/api/coordinator/attention` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/coordinator/attention/route.ts) |
| GET, POST | `/api/coordinator/messages` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/coordinator/messages/route.ts) |
| GET, PUT | `/api/coordinator/runtime` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/coordinator/runtime/route.ts) |
| DELETE, GET | `/api/credentials` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/credentials/route.ts) |
| POST | `/api/credentials/oidc` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/credentials/oidc/route.ts) |
| GET | `/api/cron/account-deletions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/account-deletions/route.ts) |
| GET | `/api/cron/audit-retention` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/audit-retention/route.ts) |
| GET | `/api/cron/briefings` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/briefings/route.ts) |
| GET, POST | `/api/cron/coordinator-wakes` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/coordinator-wakes/route.ts) |
| GET | `/api/cron/credential-cleanup` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/credential-cleanup/route.ts) |
| GET | `/api/cron/linear-sync` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/linear-sync/route.ts) |
| GET | `/api/cron/ops-monitor` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/ops-monitor/route.ts) |
| GET | `/api/cron/reconcile` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/reconcile/route.ts) |
| GET | `/api/cron/run-recovery` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/run-recovery/route.ts) |
| GET | `/api/cron/schedules` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/schedules/route.ts) |
| GET | `/api/cron/subscriptions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/subscriptions/route.ts) |
| GET | `/api/cron/suggestions-reconcile` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/suggestions-reconcile/route.ts) |
| GET | `/api/cron/user-facts` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/cron/user-facts/route.ts) |
| POST | `/api/desktop/begin` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/desktop/begin/route.ts) |
| GET | `/api/desktop/config` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/desktop/config/route.ts) |
| GET | `/api/desktop/discovery` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/desktop/discovery/route.ts) |
| POST | `/api/desktop/exchange` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/desktop/exchange/route.ts) |
| GET | `/api/desktop/finish` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/desktop/finish/route.ts) |
| GET | `/api/desktop/return` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/desktop/return/route.ts) |
| POST | `/api/desktop/rpc` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/desktop/rpc/route.ts) |
| GET | `/api/device-tokens` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/device-tokens/route.ts) |
| POST | `/api/device-tokens/[tokenId]/revoke` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/device-tokens/[tokenId]/revoke/route.ts) |
| GET, POST | `/api/devices/computer` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/devices/computer/route.ts) |
| GET, POST | `/api/devices/enrollment` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/devices/enrollment/route.ts) |
| POST | `/api/devices/ssh` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/devices/ssh/route.ts) |
| GET, POST | `/api/devices/[deviceId]/commands` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/devices/[deviceId]/commands/route.ts) |
| GET, POST | `/api/drive/volumes` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/route.ts) |
| GET | `/api/drive/volumes/[volumeId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/[volumeId]/route.ts) |
| POST | `/api/drive/volumes/[volumeId]/blobs` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/[volumeId]/blobs/route.ts) |
| PATCH | `/api/drive/volumes/[volumeId]/entries` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/[volumeId]/entries/route.ts) |
| GET | `/api/drive/volumes/[volumeId]/files` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/[volumeId]/files/route.ts) |
| POST | `/api/drive/volumes/[volumeId]/restore` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/[volumeId]/restore/route.ts) |
| GET | `/api/drive/volumes/[volumeId]/versions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/[volumeId]/versions/route.ts) |
| GET | `/api/drive/volumes/[volumeId]/versions/[versionId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/drive/volumes/[volumeId]/versions/[versionId]/route.ts) |
| POST | `/api/enterprise/link` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/enterprise/link/route.ts) |
| GET | `/api/enterprise/logout-target` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/enterprise/logout-target/route.ts) |
| GET, POST | `/api/factory/agent-profiles` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/agent-profiles/route.ts) |
| DELETE, GET, PATCH | `/api/factory/agent-profiles/[profileId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/agent-profiles/[profileId]/route.ts) |
| GET, POST | `/api/factory/monitor-incidents/[incidentId]/links` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/monitor-incidents/[incidentId]/links/route.ts) |
| GET | `/api/factory/questions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/questions/route.ts) |
| GET, POST | `/api/factory/questions/[questionId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/questions/[questionId]/route.ts) |
| POST | `/api/factory/questions/[questionId]/recover` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/questions/[questionId]/recover/route.ts) |
| GET, POST | `/api/factory/tasks` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/route.ts) |
| POST | `/api/factory/tasks/route` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/route/route.ts) |
| GET, POST | `/api/factory/tasks/[taskId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/route.ts) |
| GET | `/api/factory/tasks/[taskId]/activity` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/activity/route.ts) |
| GET, POST | `/api/factory/tasks/[taskId]/approval` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/approval/route.ts) |
| GET | `/api/factory/tasks/[taskId]/dispatch` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/dispatch/route.ts) |
| POST | `/api/factory/tasks/[taskId]/dispatch/cloud` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/dispatch/cloud/route.ts) |
| GET | `/api/factory/tasks/[taskId]/evidence/[captureId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/evidence/[captureId]/route.ts) |
| GET, POST | `/api/factory/tasks/[taskId]/flow` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/flow/route.ts) |
| GET | `/api/factory/tasks/[taskId]/media/[captureId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/media/[captureId]/route.ts) |
| GET | `/api/factory/tasks/[taskId]/media/[captureId]/poster` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/factory/tasks/[taskId]/media/[captureId]/poster/route.ts) |
| GET | `/api/frontend/oauth-consent` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/apps/api/routes/oauth-consent.ts) |
| GET, POST | `/api/github/manifest` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/github/manifest/route.ts) |
| GET | `/api/github/manifest/callback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/github/manifest/callback/route.ts) |
| POST | `/api/github/pull-request-status` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/github/pull-request-status/route.ts) |
| GET | `/api/health` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/health/route.ts) |
| GET, POST | `/api/inbox` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/inbox/route.ts) |
| DELETE, GET, PATCH, POST | `/api/integrations/composio` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/composio/route.ts) |
| GET | `/api/integrations/composio/callback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/composio/callback/route.ts) |
| GET | `/api/integrations/composio/catalog` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/composio/catalog/route.ts) |
| GET | `/api/integrations/composio/catalog/[toolkit]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/composio/catalog/[toolkit]/route.ts) |
| POST | `/api/integrations/composio/credentials` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/composio/credentials/route.ts) |
| DELETE, GET | `/api/integrations/github` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/github/route.ts) |
| GET | `/api/integrations/github/connect` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/github/connect/route.ts) |
| GET, POST | `/api/integrations/github/connect/intent` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/github/connect/intent/route.ts) |
| POST | `/api/integrations/github/connect/intent/confirm` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/github/connect/intent/confirm/route.ts) |
| GET | `/api/integrations/github/install` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/github/install/route.ts) |
| GET, PATCH | `/api/integrations/github/repositories/verification` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/github/repositories/verification/route.ts) |
| GET | `/api/integrations/google/callback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/google/callback/route.ts) |
| GET | `/api/integrations/linear/callback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/linear/callback/route.ts) |
| GET | `/api/integrations/linear/status` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/linear/status/route.ts) |
| DELETE, GET, PATCH, POST | `/api/integrations/mcp` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/mcp/route.ts) |
| PATCH | `/api/integrations/mcp/shares` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/mcp/shares/route.ts) |
| GET, POST | `/api/integrations/slack` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/slack/route.ts) |
| GET | `/api/integrations/slack/callback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/slack/callback/route.ts) |
| GET | `/api/integrations/slack/connect` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/integrations/slack/connect/route.ts) |
| POST | `/api/internal/eve/slack-credential` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/internal/eve/slack-credential/route.ts) |
| POST | `/api/internal/eve/tools` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/internal/eve/tools/route.ts) |
| POST | `/api/internal/github/workflow-result` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/internal/github/workflow-result/route.ts) |
| GET | `/api/issues/search` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/issues/search/route.ts) |
| GET | `/api/live/ticket` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/live/ticket/route.ts) |
| DELETE, GET, POST | `/api/mcp` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mcp/route.ts) |
| DELETE | `/api/mobile/artifacts/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/artifacts/[id]/route.ts) |
| POST | `/api/mobile/bots` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/bots/route.ts) |
| GET, PATCH | `/api/mobile/bots/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/bots/[id]/route.ts) |
| GET, POST | `/api/mobile/chat` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/chat/route.ts) |
| PUT | `/api/mobile/chat-order` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/chat-order/route.ts) |
| GET | `/api/mobile/chat/image` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/chat/image/route.ts) |
| POST | `/api/mobile/chat/retry` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/chat/retry/route.ts) |
| POST | `/api/mobile/chat/stop` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/chat/stop/route.ts) |
| PATCH | `/api/mobile/groups/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/groups/[id]/route.ts) |
| GET | `/api/mobile/home` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/home/route.ts) |
| GET, POST, PUT | `/api/mobile/model` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/model/route.ts) |
| GET, POST | `/api/mobile/open` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/open/route.ts) |
| POST | `/api/mobile/pending-actions/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/pending-actions/[id]/route.ts) |
| GET, PATCH | `/api/mobile/preferences` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/preferences/route.ts) |
| DELETE, POST | `/api/mobile/push-tokens` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/push-tokens/route.ts) |
| GET, POST | `/api/mobile/reactions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/reactions/route.ts) |
| GET | `/api/mobile/settings` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/settings/route.ts) |
| POST | `/api/mobile/task-presentations` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/task-presentations/route.ts) |
| GET | `/api/mobile/tasks` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/tasks/route.ts) |
| GET | `/api/mobile/tasks/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/tasks/[id]/route.ts) |
| GET | `/api/mobile/threads` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/threads/route.ts) |
| GET, POST | `/api/mobile/threads/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/threads/[id]/route.ts) |
| POST | `/api/mobile/threads/[id]/continue` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/threads/[id]/continue/route.ts) |
| GET | `/api/mobile/threads/[id]/machine` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/threads/[id]/machine/route.ts) |
| POST | `/api/mobile/threads/[id]/stop` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/mobile/threads/[id]/stop/route.ts) |
| POST | `/api/organization-invitations/accept` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organization-invitations/accept/route.ts) |
| GET, POST | `/api/organizations` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/route.ts) |
| DELETE, GET, PATCH | `/api/organizations/[organizationId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/route.ts) |
| GET | `/api/organizations/[organizationId]/api-keys` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/api-keys/route.ts) |
| PATCH | `/api/organizations/[organizationId]/api-keys/[keyId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/api-keys/[keyId]/route.ts) |
| PATCH, POST | `/api/organizations/[organizationId]/approvals` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/approvals/route.ts) |
| GET, POST | `/api/organizations/[organizationId]/audit-log` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/audit-log/route.ts) |
| GET, POST | `/api/organizations/[organizationId]/billing` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/billing/route.ts) |
| GET, POST | `/api/organizations/[organizationId]/identity` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/identity/route.ts) |
| DELETE, GET, POST | `/api/organizations/[organizationId]/invitations` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/invitations/route.ts) |
| DELETE, PATCH, POST | `/api/organizations/[organizationId]/members` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/members/route.ts) |
| GET, PATCH | `/api/organizations/[organizationId]/policy` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/policy/route.ts) |
| DELETE, POST | `/api/organizations/[organizationId]/workspaces` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/organizations/[organizationId]/workspaces/route.ts) |
| GET | `/api/pending-actions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/pending-actions/route.ts) |
| GET, POST | `/api/projects/[projectId]/decisions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/projects/[projectId]/decisions/route.ts) |
| POST | `/api/projects/[projectId]/decisions/from-message` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/projects/[projectId]/decisions/from-message/route.ts) |
| GET | `/api/projects/[projectId]/map` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/projects/[projectId]/map/route.ts) |
| GET | `/api/projects/[projectId]/map/nodes/[nodeId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/projects/[projectId]/map/nodes/[nodeId]/route.ts) |
| GET | `/api/projects/[projectId]/map/overview` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/projects/[projectId]/map/overview/route.ts) |
| GET | `/api/projects/[projectId]/map/path` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/projects/[projectId]/map/path/route.ts) |
| GET | `/api/projects/[projectId]/map/sources/[sourceRef]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/projects/[projectId]/map/sources/[sourceRef]/route.ts) |
| POST | `/api/rpc` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/apps/api/routes/browser-rpc.ts) |
| POST | `/api/runs/github-token` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/github-token/route.ts) |
| DELETE, GET, POST | `/api/runs/mcp/[toolkit]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/mcp/[toolkit]/route.ts) |
| GET | `/api/runs/[runId]/evidence` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/evidence/route.ts) |
| GET | `/api/runs/[runId]/workspace/diff` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/diff/route.ts) |
| GET | `/api/runs/[runId]/workspace/diff/[snapshotId]/file` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/diff/[snapshotId]/file/route.ts) |
| GET | `/api/runs/[runId]/workspace/diff/[snapshotId]/files` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/diff/[snapshotId]/files/route.ts) |
| GET, POST | `/api/runs/[runId]/workspace/diff/[snapshotId]/github-review` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/diff/[snapshotId]/github-review/route.ts) |
| GET, POST | `/api/runs/[runId]/workspace/diff/[snapshotId]/review` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/diff/[snapshotId]/review/route.ts) |
| GET, POST | `/api/runs/[runId]/workspace/diff/[snapshotId]/review-batches` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/diff/[snapshotId]/review-batches/route.ts) |
| GET | `/api/runs/[runId]/workspace/files` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/files/route.ts) |
| GET | `/api/runs/[runId]/workspace/git/checkpoints` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/checkpoints/route.ts) |
| POST | `/api/runs/[runId]/workspace/git/checkpoints/restore` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/checkpoints/restore/route.ts) |
| POST | `/api/runs/[runId]/workspace/git/checkpoints/restore/preview` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/checkpoints/restore/preview/route.ts) |
| GET | `/api/runs/[runId]/workspace/git/commits/[commitSha]/diff` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/commits/[commitSha]/diff/route.ts) |
| GET | `/api/runs/[runId]/workspace/git/history` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/history/route.ts) |
| POST | `/api/runs/[runId]/workspace/git/revert` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/revert/route.ts) |
| POST | `/api/runs/[runId]/workspace/git/revert/preview` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/revert/preview/route.ts) |
| GET | `/api/runs/[runId]/workspace/git/status` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/status/route.ts) |
| POST | `/api/runs/[runId]/workspace/git/undo` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/git/undo/route.ts) |
| GET | `/api/runs/[runId]/workspace/identity` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/identity/route.ts) |
| POST | `/api/runs/[runId]/workspace/mentions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/runs/[runId]/workspace/mentions/route.ts) |
| DELETE, GET, PATCH, POST, PUT | `/api/scim/v2/[connectionId]/[[...resource]]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/scim/v2/[connectionId]/[[...resource]]/route.ts) |
| GET | `/api/search` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/search/route.ts) |
| GET, PATCH | `/api/secrets/delivery` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/secrets/delivery/route.ts) |
| GET, POST | `/api/self-improvement` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/self-improvement/route.ts) |
| GET | `/api/server` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/server/route.ts) |
| GET | `/api/service-identity/projects` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/service-identity/projects/route.ts) |
| GET | `/api/service-identity/projects/[projectId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/service-identity/projects/[projectId]/route.ts) |
| GET | `/api/settings/[read]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/settings/[read]/route.ts) |
| DELETE, GET, PATCH, POST | `/api/skills` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/skills/route.ts) |
| GET | `/api/skills/search` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/skills/search/route.ts) |
| POST | `/api/skills/share` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/skills/share/route.ts) |
| GET, POST | `/api/subscriptions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/subscriptions/route.ts) |
| GET | `/api/subscriptions/callback` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/subscriptions/callback/route.ts) |
| POST | `/api/subscriptions/enrollments` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/subscriptions/enrollments/route.ts) |
| GET, POST | `/api/subscriptions/enrollments/bind` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/subscriptions/enrollments/bind/route.ts) |
| GET, POST | `/api/subscriptions/enrollments/handoff` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/subscriptions/enrollments/handoff/route.ts) |
| GET | `/api/subscriptions/usage` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/subscriptions/usage/route.ts) |
| GET | `/api/suggestions` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/suggestions/route.ts) |
| DELETE | `/api/suggestions/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/suggestions/[id]/route.ts) |
| POST | `/api/suggestions/[id]/start` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/suggestions/[id]/start/route.ts) |
| DELETE, GET, POST | `/api/tasks/[taskId]/attachments` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/attachments/route.ts) |
| GET | `/api/tasks/[taskId]/review` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/route.ts) |
| GET | `/api/tasks/[taskId]/review/checks` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/checks/route.ts) |
| GET | `/api/tasks/[taskId]/review/file` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/file/route.ts) |
| POST | `/api/tasks/[taskId]/review/merge` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/merge/route.ts) |
| GET | `/api/tasks/[taskId]/review/preview` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/preview/route.ts) |
| GET | `/api/tasks/[taskId]/review/resources` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/resources/route.ts) |
| POST | `/api/tasks/[taskId]/review/reviewed` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/reviewed/route.ts) |
| POST | `/api/tasks/[taskId]/review/send` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/send/route.ts) |
| GET | `/api/tasks/[taskId]/review/summary` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/summary/route.ts) |
| DELETE, GET | `/api/tasks/[taskId]/review/terminal` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/terminal/route.ts) |
| POST | `/api/tasks/[taskId]/review/terminal/input` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/terminal/input/route.ts) |
| POST | `/api/tasks/[taskId]/review/terminal/resize` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/tasks/[taskId]/review/terminal/resize/route.ts) |
| GET | `/api/teams/directory` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/teams/directory/route.ts) |
| GET | `/api/teams/[teamId]/members` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/teams/[teamId]/members/route.ts) |
| GET | `/api/test-environment` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/test-environment/route.ts) |
| POST | `/api/test-workspace` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/test-workspace/route.ts) |
| POST | `/api/threads/[runId]/credentials` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/threads/[runId]/credentials/route.ts) |
| POST | `/api/threads/[runId]/credentials/challenge` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/threads/[runId]/credentials/challenge/route.ts) |
| POST | `/api/threads/[runId]/credentials/login` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/threads/[runId]/credentials/login/route.ts) |
| POST | `/api/threads/[runId]/machine` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/threads/[runId]/machine/route.ts) |
| GET | `/api/version` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/version/route.ts) |
| POST | `/api/web/begin` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/web/begin/route.ts) |
| GET | `/api/web/complete` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/web/complete/route.ts) |
| POST | `/api/web/exchange` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/web/exchange/route.ts) |
| GET | `/api/web/return` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/web/return/route.ts) |
| POST | `/api/web/revoke` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/web/revoke/route.ts) |
| POST | `/api/webhooks/composio` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/webhooks/composio/route.ts) |
| POST | `/api/webhooks/github` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/webhooks/github/route.ts) |
| POST | `/api/webhooks/linear` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/webhooks/linear/route.ts) |
| POST | `/api/webhooks/slack` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/webhooks/slack/route.ts) |
| POST | `/api/webhooks/telegram` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/webhooks/telegram/route.ts) |
| GET | `/api/workspace` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspace/route.ts) |
| GET | `/api/workspace/switcher` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspace/switcher/route.ts) |
| GET | `/api/workspaces/[workspaceId]/audit-log` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/audit-log/route.ts) |
| GET, PUT | `/api/workspaces/[workspaceId]/audit-log/retention` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/audit-log/retention/route.ts) |
| GET, POST | `/api/workspaces/[workspaceId]/billing` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/billing/route.ts) |
| GET, POST | `/api/workspaces/[workspaceId]/computer-policy` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/computer-policy/route.ts) |
| GET, POST | `/api/workspaces/[workspaceId]/governance` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/governance/route.ts) |
| GET | `/api/workspaces/[workspaceId]/governance/usage` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/governance/usage/route.ts) |
| GET, POST | `/api/workspaces/[workspaceId]/model-admission` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/model-admission/route.ts) |
| GET, POST | `/api/workspaces/[workspaceId]/service-identities` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/service-identities/route.ts) |
| GET, PATCH | `/api/workspaces/[workspaceId]/service-identities/[identityId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/service-identities/[identityId]/route.ts) |
| GET, POST | `/api/workspaces/[workspaceId]/service-identities/[identityId]/credential` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/service-identities/[identityId]/credential/route.ts) |
| GET, PUT | `/api/workspaces/[workspaceId]/service-identities/[identityId]/projects` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/service-identities/[identityId]/projects/route.ts) |
| GET, POST | `/api/workspaces/[workspaceId]/skills` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/api/workspaces/[workspaceId]/skills/route.ts) |
| POST | `/v1/devices/enroll` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/enroll/route.ts) |
| POST | `/v1/devices/register` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/register/route.ts) |
| GET | `/v1/devices/[deviceId]/commands` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/commands/route.ts) |
| POST | `/v1/devices/[deviceId]/commands/ack` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/commands/ack/route.ts) |
| POST | `/v1/devices/[deviceId]/computer` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/computer/route.ts) |
| POST | `/v1/devices/[deviceId]/coordinator` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/coordinator/route.ts) |
| GET | `/v1/devices/[deviceId]/fs/requests` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/fs/requests/route.ts) |
| POST | `/v1/devices/[deviceId]/fs/requests/[requestId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/fs/requests/[requestId]/route.ts) |
| GET | `/v1/devices/[deviceId]/gateway` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/gateway/route.ts) |
| POST | `/v1/devices/[deviceId]/github-token` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/github-token/route.ts) |
| POST | `/v1/devices/[deviceId]/heartbeat` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/heartbeat/route.ts) |
| GET | `/v1/devices/[deviceId]/repos` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/repos/route.ts) |
| GET | `/v1/devices/[deviceId]/runs` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/runs/route.ts) |
| GET | `/v1/devices/[deviceId]/runs/[runId]/attachments/[id]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/runs/[runId]/attachments/[id]/route.ts) |
| POST | `/v1/devices/[deviceId]/runs/[runId]/claim` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts) |
| GET | `/v1/devices/[deviceId]/runs/[runId]/computer-authority` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/runs/[runId]/computer-authority/route.ts) |
| POST | `/v1/devices/[deviceId]/runs/[runId]/credentials/login` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/runs/[runId]/credentials/login/route.ts) |
| POST | `/v1/devices/[deviceId]/runs/[runId]/subscription` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/runs/[runId]/subscription/route.ts) |
| POST | `/v1/devices/[deviceId]/runs/[runId]/subscription-lease` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/runs/[runId]/subscription-lease/route.ts) |
| POST | `/v1/devices/[deviceId]/workspace/requests/[requestId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/devices/[deviceId]/workspace/requests/[requestId]/route.ts) |
| POST | `/v1/mailbox` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/mailbox/route.ts) |
| PATCH | `/v1/runs/[runId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/route.ts) |
| POST | `/v1/runs/[runId]/captures` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/captures/route.ts) |
| POST, PUT | `/v1/runs/[runId]/captures/[captureId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/captures/[captureId]/route.ts) |
| POST | `/v1/runs/[runId]/captures/[captureId]/complete` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/captures/[captureId]/complete/route.ts) |
| POST | `/v1/runs/[runId]/checkpoint` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/checkpoint/route.ts) |
| POST | `/v1/runs/[runId]/complete` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/complete/route.ts) |
| POST | `/v1/runs/[runId]/decision` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/decision/route.ts) |
| POST | `/v1/runs/[runId]/events` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/events/route.ts) |
| GET, POST | `/v1/runs/[runId]/policy-snapshot` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/policy-snapshot/route.ts) |
| POST | `/v1/runs/[runId]/screen` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/screen/route.ts) |
| GET | `/v1/runs/[runId]/skill-receipt` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/skill-receipt/route.ts) |
| POST | `/v1/runs/[runId]/tool-approval` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/runs/[runId]/tool-approval/route.ts) |
| POST | `/v1/task-secrets/[runId]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/v1/task-secrets/[runId]/route.ts) |
| GET | `/w/[slug]` | [source](https://github.com/alexj11324/Mikka/blob/6890ed6fb3d4751addc94baeb21e745c15ca4137/app/w/[slug]/route.ts) |
