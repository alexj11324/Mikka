# Non-Linear feature rollout · 2026-10-29

Alex requested opening the already implemented features except Linear bidirectional sync. This does not authorize a new Scheduler, desktop work, new provider grants, publication authority, credential access or production SQL. Tracking: [#408](https://github.com/alexj11324/Mikka/issues/408).

No production environment variable, database row, migration history, credential, identity, provider grant, resource or Linear setting was changed during this investigation. The rollout is blocked; source changes below prepare admission and do not establish a production release.

## Production evidence

Read-only checks on 2026-10-29, approximately 14:55–15:01 UTC:

- Vercel deployment `dpl_AQzeTKZurougYRaYjf2dejX6pNQX` is READY, serves `app.aspectlylabs.com`, and identifies main `04d7b67d286f9c0453f4709f04b1f046b218de48` (#406). Its frozen origin is `https://mikka-g7wzwonma-mikka-dev.vercel.app`; unauthenticated requests there stop at Vercel protection. The following public-domain probes are point-in-time observations, not frozen authenticated acceptance.
- POST `/mikka/api/approved-writes` with an empty JSON object returns 503 `approvedWritesDisabled` before admission (request `2zfbc-1793286031284-3666be5f6714`). No proposal or provider operation was created.
- GET `/mikka/api/credentials` returns 503 `credential_unavailable` (request `8m97l-1793286031842-651fa7e2c1a4`).
- GET `/mikka/api/factory/tasks` and an unauthenticated computer-runtime GET return 500 (requests `8zv45-1793286033118-b2ab428f9326` and `dz9l9-1793286032576-26aea7e67d11`). Logs scoped to the deployment report Better Auth `SCHEMA_MISMATCH`, missing table `deviceCode`. This is an observed login-runtime blocker, not a speculative feature failure.
- Existing Infisical Universal Auth successfully read the authorized Mikka project's production configuration. Schema/history queries used HTTPS SQL and returned metadata only. `MIKKA_DATABASE_URL` and the production `/neon` `DATABASE_URL` identify the same Neon host and database: `ep-twilight-violet-b5lbqgbv-pooler.c-7.us-east-2.aws.neon.tech`, `orvilo_mvp`.
- That database records 82 migration names, the newest lexically `20261027231815_user_facts.sql`. Comparing current source through `alreadyApplied` leaves 44 application migrations without a recognized history entry. This is **not** evidence that every corresponding SQL body is unapplied: for example, the operation ledger, approval bindings and older Factory tables already exist. Do not replay all 44 or manufacture migration-history entries.
- `deviceCode`, `bot_subagents`, `subagent_events`, `workspace_snapshots`, `thread_machines`, `suggestion_executions` and all six current credential-vault tables are absent. `credential_requests` is a different historical implementation and cannot substitute for the new vault schema.
- `agent_kit_heads` and `workspace_computer_policies` lack both external-write policy columns. `factory_tasks` lacks `botId` and `scopeVersion`; Factory approval/evidence/control records lack the current principal/decision fields. `cloud_machines` still has primary key `(workspaceId)`, with no provision lease columns.
- Production configuration contains `MIKKA_CLOUD_COMPUTER_TASKS=1` and `MIKKA_BYOS_ENABLED=1`. Factory routing/lifecycle, Agent Kit, issue tools, thread-machine and credential-vault enablement keys are absent. Sensitive configuration values are not returned by a Vercel list operation; an empty returned value must not be interpreted as a missing runtime secret.

## Scope and current state

| Capability | State and next dependency |
| --- | --- |
| Existing Gmail send and Calendar create/update proposals | Already wired through `createGoogleAITools`, `proposeAccountAction` and the existing pending-action approval path. They are separate from `PERSONAL_WRITES_ENABLED`. No actual provider success was tested here; the observed auth-schema blocker affects authenticated runtime checks. |
| Telegram / Slack ingress | Existing implementations and deployment configuration. No new flag was needed or changed; no message or provider write was sent. |
| Factory intake, questions, continuation, independent review/verify and repair dispatch | Implemented and currently disabled. Requires production schema reconciliation and existing model/daemon capability acceptance, then scoped `MIKKA_ISSUE_TOOLS_ENABLED`, `MIKKA_FACTORY_ROUTING_ENABLED` and `MIKKA_FACTORY_LIFECYCLE_ENABLED` rollout. Resume fixtures do not establish actual Claude/Codex resume acceptance. |
| Factory policy publication | Still blocked beyond flags: `server.ts` supplies no decision authority, and the documented host seam has no live registered publication policy/version source or authenticated review attestation issuer/key. `createFactoryPublicationHost` is a constructor, not a configured production source. Do not synthesize an allow decision or use general network/Git permission as publication authority. |
| Factory monitoring | Existing probes, receipt validation, deduplication and issue association; production lifecycle schema/configuration and publication evidence are prerequisites. `planMonitorIssueAssociation` returns `propose-new` when no issue matches; that return value alone is not automatic issue creation and repair dispatch. |
| New approved writes | Notion append, Slack send and Calendar delete are the actions behind the default-off service. The new server rollout configuration admits their existing HTTP/model/policy/ledger path; database policy columns, Agent Kit and real provider acceptance remain prerequisites. No provider allow/ask/deny or frozen tool grant changes. |
| Credential vault and guarded web login | Existing code and AWS configuration sources, but production schema and a broker deployment bound to the correct production app/database/commit remain required. Only web-subagent login is currently admitted by `login`; coding-run login remains unavailable. No new credential access or role trust was granted. |
| Cloud desktop / browser subagents | Prior desktop viewing/takeover evidence does not establish the current schema-dependent browser workflow. #406's runtime and owner-machine migrations remain absent; authenticate after the device-code prerequisite and verify before declaring this open. |
| Hosted coding / per-thread machines | Top-level cloud/BYOS flags already on; per-thread machines remain disabled and their tables are absent. Validated native/model subscription routes and actual existing provider execution still need evidence. Do not enable per-thread provisioning without approving its resource/cost impact. |
| Local Linux computer use | Existing daemon code and previously recorded driver tests; server availability cannot enable a daemon already installed on a user's computer. No local Electron, daemon upgrade, macOS acceptance or new local-control grant was performed. |
| General user Scheduler | Not implemented. Existing briefings/cron jobs are separate; no new Scheduler was built. |
| Linear bidirectional sync | Existing state preserved; no code, switch, migration, worker, token or business data was changed. |

## First concrete production prerequisite (not executed)

The observed 500s identify one immediate action to approve separately:

- Target: the existing production `orvilo_mvp` database above, used by both application and workspace configuration. Use its direct connection for DDL; do not send a pooled URL to the migration executor.
- Source: `drizzle/20261029023121_device_authorization.sql` at `04d7b67d286f9c0453f4709f04b1f046b218de48`.
- SHA-256: `b04be21d6641914e55113464452d2d4d4b83a767df4bf9b7a7b5b3471c52e414`.
- Action: create `deviceCode` and its two unique indexes, and record this exact migration through a reviewed bounded invocation of the existing executor. The file already uses a transaction and a five-second lock timeout. Add a bounded statement timeout in the approved execution context. No existing business row is updated or deleted; no feature, provider or Linear permission is granted by this schema action.
- Recovery: verify the existing backup/restore window before execution; do not create or reset a production branch implicitly. On an execution or COMMIT error, inspect the table/indexes and ledger before any retry. Preserve a successfully created table and its records; automatic DROP is not part of rollback.
- Follow-up: repeat the two unauthenticated read-only probes and inspect deployment logs. A successful auth-schema check only clears this prerequisite; it does not establish feature/provider acceptance.

The additional [candidate manifest](non-linear-rollout-migrations-20261029.json) identifies eight other demonstrated schema dependencies and their immutable SQL hashes. It is not an execution plan or approval to apply those files. Factory public-consumer SQL includes historical-row backfills, owner-machine SQL changes key/foreign-key constraints, and further current/legacy schema reconciliation is required. Keep all Linear-related migration bodies outside this bounded rollout; do not invoke the generic all-pending migration command against production.

## Prepared admission change and verification

`personalWritesEnabled` accepts server-owned `MIKKA_PERSONAL_WRITES_ENABLED=1`; absent configuration retains the old default/Preview behavior. Any explicit other value closes admission, including legacy Preview admission. Roll forward or back through the deployment's environment configuration and deployment lifecycle. This is not a hot toggle and does not itself make the database/provider ready.

Cloud Linux source checks passed: `pnpm check`, 55 approved-write tests (zero skips), TypeScript and lint. Optional environment-dependent tests inside `pnpm check` retain their normal skip behavior; that command is not a production database acceptance run. The approved-write tests verify production admission reaches the existing authenticated HTTP service, rejects bearer credentials, cross-origin input and caller-selected owner data, and keeps durable IDs and uncertain outcomes on the same path. Auth/database/provider leaves in the route test are synthetic; they do not establish real provider, browser or production acceptance.

Unchanged baseline main CI, build and full browser results remain associated with #406: [CI 40876642201](https://github.com/alexj11324/Mikka/actions/runs/40876642201) and [Browser tests 40876642408](https://github.com/alexj11324/Mikka/actions/runs/40876642408). They are baseline evidence, not validation of the rollout diff or proof of production migration/provider readiness. No synthetic production records or new test infrastructure were created by this work.
