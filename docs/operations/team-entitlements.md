# Team Free / Team Pro operations and API contract

Implements the Team part of [#1608](https://github.com/alexj11324/Mikka/issues/1608), after the workspace ownership P0. Workspace kind remains `personal | team`; a shared workspace's product plan is independent of membership, roles, credential consent and run authorization. Organization aggregation and identity governance are delivered by the separate Enterprise PR.

## Effective entitlements

| Deployment and workspace | Human seats | Hosted calls in flight | Team usage/export | Saved approval templates |
| --- | --- | --- | --- | --- |
| Cloud Personal | Owner only | 8 | Existing personal usage | 0 |
| Cloud Shared, no effective grant | 5 active members | 8 | Existing basic usage | 0 |
| Cloud Shared, Team Pro grant | Explicit grant limit | 32 | Administrator JSON/CSV | 100 |
| Community self-hosted | Unlimited | Own provider; hosted metering bypassed | Administrator JSON/CSV | 100 |

`MIKKA_EDITION` follows the canonical `lib/edition.ts`: only `cloud` selects Cloud, and an unset or empty value selects Community on every host, including Vercel. Values are trimmed; invalid values fail configuration. Cloud deployments must explicitly select Cloud in their build and runtime configuration. Community own-provider usage bypasses hosted plan quota and billing ledger access; usage reports never manufacture costs for BYOS runs. Explicitly selected Mikka Cloud services retain their own server-authorized usage admission and settlement; this local bypass does not grant free remote services or record the same cost twice. Cloud grants have `source=cloud`; a self-hosted commercial license has `source=license`. An expired or mismatched grant falls back to the deployment's free edition.

Only active rows in `mikka_workspace_members` count as humans. Invitations, suspended memberships, Bots, Agents, devices, tasks and runs do not count. Invitation acceptance and member reactivation acquire the workspace lock and keep it through the membership commit. Concurrent attempts for the fifth Cloud Free seat admit one person. Refused invitations remain pending. Downgrading an over-limit workspace preserves all members, tasks, data, saved templates and already applied policies; new seat consumption and new paid operations are refused. Existing basic ACL, own-model use, sharing consent and PAT/delegation boundaries are independent of the plan.

Hosted quota is a product concurrency ceiling on the existing hosted usage store. Its short workspace plan lease is acquired before the APP checkout, matching task writers. Usage and template application use the same pinned workspace transaction as P0, and retain current membership and plan authority through the APP commit. Verification, credit availability, abuse limits, actual usage settlement and authorization still apply. A grant creates no credits, subscriptions, card operations or charges. BYOS usage is not turned into hosted usage or synthetic cost.

## Operator provisioning

Company provisioning procedures are maintained through the
[private operations entry](README.md). There is no public plan-mutation endpoint.
A grant and its audit event commit atomically; a failed audit write rolls back
the grant. Plan changes create no billing credits or provider subscriptions.

## Backend contract for the Claude UI session

The current workspace ID is mandatory in every URL. All routes require a fresh session; workspace-scoped PATs remain limited to their own workspace. Responses are `private, no-store`. Error bodies use `error.code=governance_denied` and a closed `detail` with Chinese and English copy in `RunErrors.governance_denied`.

| Route | Authority | Response or mutation |
| --- | --- | --- |
| `GET /api/workspaces/:workspaceId/governance` | Active member | Effective edition/plan, `activeHumans`, `workspaceActiveHumans`, `activeHumanLimit`, `overLimit`, `hostedMaxInFlight`, feature booleans, `approvalTemplateLimit`, `canEdit`, and accessible `templates` |
| `POST /api/workspaces/:workspaceId/governance` with `action=save` | Administrator with templates entitlement | `template: { id?, name, rules }`; returns `{ id }` |
| Same route, `action=apply` | Administrator with templates entitlement | `templateId`; applies the persisted template in this workspace to actual CLI run policy and returns `{ applied: true }` |
| Same route, `action=delete` | Administrator with templates entitlement | `templateId`; returns `{ deleted: true }` |
| `GET /api/workspaces/:workspaceId/governance/usage` | Administrator with export entitlement | `from`, `to` in UTC `YYYY-MM-DD`, inclusive; default 30 days, at most 93 days. Settled hosted ledger grouped by day/model, cost in microUSD, plus run counts by status |
| Same route with `format=csv` | Same | CSV attachment, escaped spreadsheet formulas, durable export audit receipt with row count and digest |

Template rules are a nonempty object with the existing `approvalMode` (`ask | read_only`), `networkAllow`, and/or configurable CLI `permissions`; `computer_use` and external-write permission fields are rejected. Applying a template preserves computer and external-write permissions, updates the real policy revision, writes an audit event in the policy transaction and stops affected running work through the existing policy-change mechanism.

UI requirements for Claude: show the effective plan and active-human seat count under shared workspace settings; render over-limit state without hiding existing members; explain rejected invitations/restorations using `seat_limit`; give admins actual usage/date-range/export and template save/apply/delete controls; render read-only membership information for ordinary members. Keep personal workspace settings separate. Do not add a payment or live Stripe price flow. The UI handoff and production screenshots belong in the separate UI PR/session.

## Migration, verification and rollback

`20261109035010_team_entitlements.sql` creates only workspace entitlement and approval-template tables. It also suspends historical non-owner personal memberships and enforces personal ownership/workspace-kind invariants below the application. It does not infer task ownership, transfer workspaces, backfill paid grants, delete members or touch billing balances. P0's task quarantine stays intact.

The required database inventory includes `tests/governance-seats.db.test.ts` and `tests/team-governance-api.db.test.ts` in `test:visibility-db`. The first uses disposable PostgreSQL databases for real invitation acceptance/restoration races, Community admission, grant expiry/downgrade, atomic provisioning and actual hosted reservation/settlement. The second uses a fully migrated isolated database and real HTTP handlers for entitlement/ACL/tenant boundaries, actual policy writes, audit and hosted usage/CSV. It runs the production APP and workspace pools with one connection each, including a real task writer racing usage and template application. The hosted reservation test also covers a workspace writer with one connection per pool. Session identity and the external scheduler transport are the only substitutions. Unit policy coverage runs in `pnpm check` through `test:governance`.

Company release verification, temporary evaluation grants and production
acceptance accounts are maintained through the [private operations entry](README.md).
Keep additive tables, audit rows, ownership safeguards and already applied
workspace policy when rolling back application code. Restore policy only
through an authorized, audited update.
