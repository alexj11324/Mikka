#!/usr/bin/env node
// MIK-19: required DB gates; only the Actions job's ephemeral PG17 is allowed.
// Inventory is tree-aware, never "missing script => skip". A feature marker requires
// its suite even if the test or package script was accidentally removed. All other
// present pg/DB test files must map to a package script or inventory fails closed.
import { spawn } from 'node:child_process'
import { availableParallelism } from 'node:os'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { isE2eTarget, E2E_DB_RULE } from '../tests/helpers/e2e-target.mjs'

export const REQUIRED_SUITES = [
  { marker: 'lib/inbox/store.ts', file: 'lib/inbox/store.db.test.ts', script: 'test:inbox-db' },
  { marker: 'app/api/factory/tasks/[taskId]/activity/route.ts', file: 'tests/factory-activity-http.db.test.ts', script: 'test:factory-activity-http-db' },
  { marker: 'lib/factory/activity.ts', file: 'lib/factory/activity.db.test.ts', script: 'test:factory-activity-db' },
  { marker: 'lib/factory/activity-artifacts.ts', file: 'lib/factory/activity-artifacts.db.test.ts', script: 'test:factory-activity-db' },
  { marker: 'lib/factory/spec-artifact.ts', file: 'lib/factory/spec-artifact.db.test.ts', script: 'test:factory-activity-db' },
  { marker: 'lib/factory/task-media.ts', file: 'lib/factory/task-media.db.test.ts', script: 'test:factory-activity-db' },
  { marker: 'lib/cloud-computer/thread-machine-sessions.ts', file: 'lib/cloud-computer/thread-machine-sessions.db.test.ts', script: 'test:factory-activity-db' },
  { marker: 'lib/factory/background-workspace.ts', file: 'tests/factory-background-workspace.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/factory/workspace-reader.ts', file: 'tests/factory-workspace-admission.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/enterprise/audit-outbox.ts', file: 'lib/enterprise/audit-outbox.db.test.ts', script: 'test:enterprise-db' },
  { marker: 'lib/enterprise/execution-authority.ts', file: 'lib/enterprise/execution-authority.db.test.ts', script: 'test:enterprise-db' },
  { marker: 'lib/enterprise/live-authority.ts', file: 'lib/enterprise/live-authority.db.test.ts', script: 'test:enterprise-db' },
  { marker: 'lib/enterprise/sso-plugin.ts', file: 'lib/enterprise/http.db.test.ts', script: 'test:enterprise-db' },
  { marker: 'lib/governance/organizations.ts', file: 'lib/enterprise/governance.db.test.ts', script: 'test:enterprise-db' },
  { marker: 'lib/mobile-push.ts', file: 'tests/mobile-push-workspace.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/governance/templates.ts', file: 'tests/team-governance-api.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/governance/entitlements.ts', file: 'tests/governance-seats.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/task-workspace.ts', file: 'tests/task-workspace-governance.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/resource-access/store.ts', file: 'tests/resource-access.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/run-private-resources.ts', file: 'tests/run-private-resources.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/cloud-services/store.ts', file: 'lib/cloud-services/client.db.test.ts', script: 'test:cloud-services-db' },
  { marker: 'app/api/web/exchange/route.ts', file: 'tests/web-auth-handoff.db.test.ts', script: 'test:web-auth-db' },
  { marker: 'lib/workspace-selection.ts', file: 'tests/web-workspace-selection.db.test.ts', script: 'test:web-auth-db' },
  { marker: 'lib/project-map/decisions.ts', file: 'lib/project-map/decisions.db.test.ts', script: 'test:project-decisions-db' },
  { marker: 'lib/chat-attachments/store.ts', file: 'lib/chat-attachments/store.db.test.ts', script: 'test:chat-attachments-db' },
  { marker: 'lib/plugins/store.ts', file: 'lib/plugins/store.db.test.ts', script: 'test:plugins-db' },
  { marker: 'lib/schedules/store.ts', file: 'lib/schedules/store.db.test.ts', script: 'test:schedules-db' },
  { marker: 'lib/run-leases.ts', file: 'tests/run-recovery.db.test.ts', script: 'test:run-recovery-db' },
  { marker: 'app/v1/runs/[runId]/checkpoint/route.ts', file: 'tests/checkpoint-recovery.db.test.ts', script: 'test:run-recovery-db' },
  { marker: 'lib/mcp/worker.ts', file: 'lib/mcp/worker-authorization.db.test.ts', script: 'test:worker-authorization-db' },
  { marker: 'lib/execution-identity.ts', file: 'lib/execution-identity.db.test.ts', script: 'test:worker-authorization-db' },
  { marker: 'lib/device-revocation.ts', file: 'lib/device-revocation.db.test.ts', script: 'test:device-revocation-db' },
  { marker:'lib/abuse/store.ts',file:'lib/abuse/store.db.test.ts',script:'test:abuse-db' },
  { marker:'lib/search/rate-limit.ts',file:'lib/search/rate-limit.db.test.ts',script:'test:abuse-db' },
  { marker: 'lib/abuse/alerts.ts', file: 'lib/abuse/alerts.db.test.ts', script: 'test:abuse-db' },
  { marker: 'lib/onboarding.ts', file: 'lib/onboarding.db.test.ts', script: 'test:onboarding-db' },
  { marker: 'lib/device-enrollment.ts', file: 'lib/device-enrollment.db.test.ts', script: 'test:device-enrollment-db' },
  { marker:'lib/execution-settings.ts',file:'lib/execution-settings.db.test.ts',script:'test:execution-settings-db' },
  { marker:'lib/execution-model-options.ts',file:'lib/execution-model-options.db.test.ts',script:'test:execution-settings-db' },
  { marker: 'lib/rule-dispatch.ts', file: 'tests/run-machine-fallback.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/thread-dispatch.ts', file: 'tests/one-thread-per-task.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/factory/questions/queue-local-continuation.ts', file: 'tests/factory-local-question.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/coordinator/coordinator-bot.ts', file: 'tests/coordinator-bot.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/run-credential-source.ts', file: 'tests/api-key-runs.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/model-order.ts', file: 'tests/model-order.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/model-provider-health.ts', file: 'tests/model-provider-health.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/run-provider-fallback.ts', file: 'tests/run-provider-fallback.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/run-provider-fallback.ts', file: 'tests/run-provider-fallback-cloud.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/run-quota.ts', file: 'tests/run-quota.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/artifacts/delete.ts', file: 'tests/artifact-delete.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/run-publications.ts', file: 'tests/run-publications.db.test.ts', script: 'test:run-publication-db' },
  { marker: 'lib/github/publication-webhook.ts', file: 'lib/github/publication-webhook.db.test.ts', script: 'test:run-publication-db' },
  { marker: 'lib/github/publication-webhook-actions.ts', file: 'tests/github-webhook-statements.db.test.ts', script: 'test:run-publication-db' },
  { marker: 'lib/cloud-computer/browser-authority.ts', file: 'lib/cloud-computer/unattended.db.test.ts', script: 'test:cloud-backend-db' },
  { marker: 'lib/credentials/store.ts', file: 'lib/credentials/store.db.test.ts', script: 'test:credentials-db' },
  { marker: 'lib/cloud-computer/subagents.ts', file: 'lib/cloud-computer/backend.db.test.ts', script: 'test:cloud-backend-db' },
  { marker: 'lib/factory/approval.ts', file: 'lib/factory/public-consumers.db.test.ts', script: 'test:factory-approval-db' },
  { marker: 'lib/factory/merge.ts', file: 'lib/factory/merge.db.test.ts', script: 'test:factory-approval-db' },
  { marker: 'lib/suggestions/card.ts', file: 'tests/suggestion-claim.integration.test.ts', script: 'test:suggestion-artifact-db' },
  { marker:'lib/self-improvement/evaluation-comparison.ts',file:'lib/self-improvement/evaluation-comparison-postgres.test.ts',script:'test:skill-semantic-db' },
  { marker: 'lib/factory/store.ts', file: 'lib/factory/postgres.test.ts', script: 'test:factory' },
  { marker: 'lib/self-improvement/store.ts', file: 'lib/self-improvement/postgres.test.ts', script: 'test:self-improvement-db' },
  { marker: 'lib/self-improvement/team-skills.ts', file: 'lib/self-improvement/team-skills.db.test.ts', script: 'test:self-improvement-db' },
  { marker: 'lib/factory/checks.ts', file: 'lib/factory/checks.db.test.ts', script: 'test:factory-checks-db' },
  { marker: 'lib/factory/automatic-dispatch.ts', file: 'lib/factory/profile-dispatch.db.test.ts', script: 'test:factory-checks-db' },
  { marker: 'lib/computer/bot-runtime-records.ts', file: 'lib/factory/profile-dispatch.db.test.ts', script: 'test:factory-checks-db' },
  { marker: 'lib/factory/agent-profile.ts', file: 'lib/factory/agent-profile.db.test.ts', script: 'test:factory-routing-db' },
  { marker: 'lib/factory/request-epoch.ts', file: 'lib/factory/continuity.db.test.ts', script: 'test:factory-checks-db' },
  { marker: 'lib/factory/watchdog.ts', file: 'lib/factory/continuity.db.test.ts', script: 'test:factory-checks-db' },
  { marker: 'lib/factory/monitor-v2-binding.ts', file: 'lib/factory/monitor-v2-binding.db.test.ts', script: 'test:factory-monitor-db' },
  { marker: 'lib/factory/check-independence.ts', file: 'lib/factory/check-independence.db.test.ts', script: 'test:factory-check-independence-db' },
  { marker: 'lib/operations/approved-writes.ts', file: 'lib/operations/write-legacy-schema.db.test.ts', script: 'test:approved-writes-db' },
  { marker: 'scripts/migration-steps.mjs', file: 'tests/migration-steps.db.test.mjs', script: 'test:migration-steps-db' },
  { marker: 'lib/factory/store.ts', file: 'lib/factory/routing.db.test.ts', script: 'test:factory-routing-db' },
  { marker: 'lib/run-admission-store.ts', file: 'tests/factory-admission.db.test.ts', script: 'test:factory-routing-db' },
  { marker: 'lib/run-chain.ts', file: 'tests/run-chain.db.test.ts', script: 'test:factory-routing-db' },
  { marker: 'lib/agent-kit/store.ts', file: 'lib/agent-kit/store.db.test.ts', script: 'test:agent-kit-db' },
  { marker: 'lib/computer/store.ts', file: 'lib/computer/store.db.test.ts', script: 'test:computer-db' },
  { marker: 'lib/computer/reconcile.ts', file: 'lib/computer/reconcile.db.test.ts', script: 'test:computer-db' },
  { marker: 'lib/computer/event-log.ts', file: 'lib/computer/event-log.db.test.ts', script: 'test:live-db' },
  { marker: 'lib/builtin-gateway/postgres.ts', file: 'lib/builtin-gateway/postgres.db.test.ts', script: 'test:live-db' },
  { marker: 'lib/live/session-ticket.ts', file: 'lib/builtin-gateway/session-revocation.db.test.ts', script: 'test:live-db' },
  { marker: 'lib/cloud-computer/subagents.ts', file: 'lib/computer/event-writers.db.test.ts', script: 'test:live-db' },
  { marker: 'lib/computer/event-page.ts', file: 'lib/computer/event-session.db.test.ts', script: 'test:live-db' },
  { marker: 'lib/credentials/broker.ts', file: 'lib/computer/event-broker.db.test.ts', script: 'test:live-db' },
  { marker: 'lib/captures/store.ts', file: 'lib/captures/store.db.test.ts', script: 'test:captures-db' },
  { marker: 'lib/group-conversations-store.ts', file: 'lib/group-conversations.test.ts', script: 'test:groups' },
  { marker: 'lib/group-conversations-store.ts', file: 'lib/group-reads.db.test.ts', script: 'test:conversation-reads' },
  { marker: 'lib/active-agents.ts', file: 'lib/active-agents.test.ts', script: 'test:active-agents' },
  { marker: 'lib/coordinator/group-turns.ts', file: 'lib/coordinator/group-turns.test.ts', script: 'test:group-turns' },
  { marker: 'lib/coordinator/group-decision-feedback.ts', file: 'lib/coordinator/group-decision-quality.db.test.ts', script: 'test:group-turns' },
  { marker: 'lib/profile/store.ts', file: 'lib/profile/store.db.test.ts', script: 'test:user-facts-db' },
  { marker: 'lib/secrets/store.ts', file: 'tests/workspace-secrets.db.test.ts', script: 'test:secrets-db' },
  { marker: 'lib/session-mailbox.ts', file: 'tests/session-mailbox.db.test.ts', script: 'test:session-mailbox-db' },
  { marker: 'lib/suggestions/time-zone.ts', file: 'tests/settings-preferences.db.test.ts', script: 'test:settings-prefs-db' },
  { marker: 'lib/tokens/store.ts', file: 'tests/personal-access-tokens.db.test.ts', script: 'test:pat-db' },
  { marker: 'lib/api-auth.ts', file: 'tests/personal-access-token-api.db.test.ts', script: 'test:pat-api-db' },
  { marker: 'lib/coordinator/bot-instructions.ts', file: 'lib/coordinator/bot-chats.db.test.ts', script: 'test:bot-chats-db' },
  { marker: 'lib/workspace-admin/bot-threads.ts', file: 'tests/bot-threads.db.test.ts', script: 'test:bot-threads-db' },
  { marker: 'lib/coordinator/store.ts', file: 'tests/coordinator-task-binding.db.ts', script: 'test:coordinator-task-binding-db' },
  { marker: 'lib/coordinator/native-store.ts', file: 'lib/coordinator/native-store.test.ts', script: 'test:coordinator-native' },
  { marker: 'lib/coordinator/issue-create.ts', file: 'tests/coordinator-issue-create.db.test.ts', script: 'test:coordinator-issue-create-db' },
  { marker: 'lib/activity-actor.ts', file: 'tests/activity-actor-db.test.ts', script: 'test:activity-actor-db' },
  { marker: 'lib/mcp/issue-mutation.ts', file: 'tests/issue-tool-calls.db.test.ts', script: 'test:coordinator-issue-tools-db' },
  { marker: 'lib/run-visibility.ts', file: 'tests/team-visibility.db.test.ts', script: 'test:visibility-db' },
  { marker: 'lib/issue-search.ts', file: 'tests/issue-search.db.test.ts', script: 'test:issue-search-db' },
  { marker: 'tests/workspace-migration.test.mjs', file: 'tests/workspace-migration.test.mjs', script: 'test:workspace-migration-db' },
  { marker: 'tests/local-repository-migration.db.test.mjs', file: 'tests/local-repository-migration.db.test.mjs', script: 'test:local-repository-migration-db' },
  { marker: 'drizzle/20261027164500_artifact_legacy_compat.sql', file: 'tests/artifact-legacy-migration.test.mjs', script: 'test:artifact-migration-db' },
  { marker: 'lib/workspace-admin/general.ts', file: 'tests/workspace-admin.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/app-policy/store.ts', file: 'tests/app-policy.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/organization-connections.ts', file: 'tests/organization-connections.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/hosted-execution-revocation.ts', file: 'tests/hosted-execution-revocation.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/model-api-keys.ts', file: 'tests/model-api-keys.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/usage/read.ts', file: 'tests/usage.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/run-bot-name.ts', file: 'tests/run-agent-names.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/run-outcome-judge.ts', file: 'tests/run-outcomes.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/billing/service.ts', file: 'tests/billing.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/billing/management.ts', file: 'tests/billing-management.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/audit/query.ts', file: 'tests/audit-query.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/subscription-acquire-expiry.ts', file: 'lib/subscription-acquire-expiry.db.test.ts', script: 'test:workspace-admin-db' },
  { marker: 'lib/issue-relation-cycle.db.test.ts', file: 'lib/issue-relation-cycle.db.test.ts', script: 'test:relation-cycle' },
  { marker: 'lib/audit/record.ts', file: 'tests/audit-record.db.test.ts', script: 'test:audit-db' },
  { marker: 'lib/audit/authentication.ts', file: 'tests/authentication-audit.db.test.ts', script: 'test:audit-db' },
  { marker: 'lib/credentials/store.ts', file: 'tests/security-lifecycle-audit.db.test.ts', script: 'test:audit-db' },
  { marker: 'lib/audit/delivery.ts', file: 'tests/audit-delivery.db.test.ts', script: 'test:audit-db' },
  { marker: 'lib/account/delete.ts', file: 'lib/account/store.db.test.ts', script: 'test:account-db' },
  { marker: 'lib/account/export-files.ts', file: 'lib/account/export-files.db.test.ts', script: 'test:account-db' },
  { marker: 'lib/agent-tool-approval/task-policy.db.test.ts', file: 'lib/agent-tool-approval/task-policy.db.test.ts', script: 'test:worker-authorization-db' },
  { marker: 'lib/abuse/store.ts', file: 'lib/abuse/model-postpay.db.test.ts', script: 'test:abuse-db' },
  { marker: 'lib/abuse/model.ts', file: 'lib/abuse/model-generation.db.test.ts', script: 'test:abuse-db' },
  { marker: 'lib/model-admission/store.ts', file: 'lib/model-admission/store.db.test.ts', script: 'test:model-admission-db' },
  { marker: 'lib/model-admission/runtime.ts', file: 'lib/model-admission/revocation-postpay.db.test.ts', script: 'test:model-admission-db' },
  { marker: 'lib/audit/export.ts', file: 'lib/audit/export.db.test.ts', script: 'test:audit-db' },
  { marker: 'lib/audit/retention.ts', file: 'lib/audit/retention.db.test.ts', script: 'test:audit-db' },
  { marker: 'lib/account/deletion-jobs.ts', file: 'lib/account/deletion-jobs.db.test.ts', script: 'test:account-db' },
  { marker: 'lib/account/external-cleanup.ts', file: 'lib/account/owner-cleanup.db.test.ts', script: 'test:account-db' },
  { marker: 'lib/account/runtime-cleanup.ts', file: 'lib/account/cloud-cleanup.db.test.ts', script: 'test:account-db' },
  { marker: 'lib/account/deletion-jobs.ts', file: 'lib/account/deletion-restore.db.test.ts', script: 'test:account-db' },
  { marker: 'lib/ops/monitor.ts', file: 'lib/ops/monitor.db.test.ts', script: 'test:ops-db' },
  { marker: 'lib/ops/egress-fallback.ts', file: 'lib/ops/egress-fallback.db.test.ts', script: 'test:ops-db' },
  { marker: 'lib/linear-sync/archive.ts', file: 'tests/linear-archive.db.test.ts', script: 'test:scope-detachment-db' },
]
// Suites that provision their own throwaway database and refuse the shared mikka_e2e service.
// Each entry names its dedicated runner; the runner must exist and still invoke the file.
export const SELF_MANAGED = [
  { file: 'tests/test-account-pool.http.test.mjs', runner: 'scripts/test-accounts/run-http.mjs', reason: 'owns the exact built Next server and registered disposable environment; runs locally (pnpm test:test-accounts-http), since CI has no browser job or production build (decision 2026-11-01-1520)', local: true },
  { file: 'lib/auth-email.test.ts', runner: 'scripts/test-auth-email.mjs', reason: 'starts its own Docker Postgres and refuses any application database' },
  { file: 'tests/byos-application.test.mjs', runner: 'scripts/test-subscription-worker.mjs', reason: 'starts an isolated BYOS Postgres and worker fixture' },
  { file: 'tests/byos-enrollment-binding.test.mjs', runner: 'scripts/test-subscription-worker.mjs', reason: 'starts an isolated BYOS Postgres and worker fixture' },
]
// Dedicated Playwright suites use their own browser runner, never node:test.
// Register exact files so another pg-backed test in the same folder still fails
// inventory until it has its own explicit gate.
export const BROWSER_SUITES = [
  { file: 'tests/mvp/coordinator-streaming.spec.ts', config: 'playwright.mvp.config.ts', script: 'test:e2e:mvp' },
  { file: 'tests/mvp/core-loop.spec.ts', config: 'playwright.mvp.config.ts', script: 'test:e2e:mvp' },
]
// These import the locked driver with real native transport denied. Every
// exact suite needs its source guard and the same guard on its pure script step.
export const OFFLINE_GUARDED = [
  {file:'scripts/test-accounts/docker-environment.test.mjs',script:'test:test-accounts',guard:'scripts/test-accounts/offline-transport.mjs',reason:'mocked pg Pool and Docker ownership responses; native transport denied while private temporary descriptor files remain real'},
  {file:'scripts/scope-native-offline.test.mjs',script:'test:scope-acceptance-guard',guard:'scripts/credential-diagnostics-offline.mjs',reason:'real pg/Drizzle API and denied-startup tests; no server SQL'},
  {file:'lib/personal-mailbox-runtime-off.test.ts',script:'test:personal-mailbox-core',guard:'scripts/credential-diagnostics-offline.mjs',reason:'spies on pg Pool/Client to assert the mailbox-off path submits no SQL; transport denied'},
  {file:'scripts/scope-fresh.test.mjs',script:'test:scope-acceptance-guard',guard:'scripts/credential-diagnostics-offline.mjs',reason:'fresh target models and native connection rejection; no server SQL'},
]
// This destructive empty-database bootstrap must stay BEFORE test:e2e:setup.
// Its workflow invocation is independently checked, not silently omitted.
export const SERVER_BACKED = ['tests/factory-query-http.test.ts', 'tests/factory-question-http.test.ts', 'tests/factory-monitor-cycle-http.test.ts']
export const BOOTSTRAP = 'tests/migrate-empty-db.test.mjs'

export function parseSummary(output) {
  const totals = {}
  for (const [, key, n] of output.matchAll(/^(?:# |ℹ )(tests|pass|fail|skipped|todo|cancelled) (\d+)\s*$/gm)) totals[key] = (totals[key] ?? 0) + Number(n)
  return totals
}
export function checkSummary(script, status, totals) {
  if (status !== 0) return `${script} exited with ${status}`
  if (!Number.isInteger(totals.tests)) return `${script}: no node:test summary found`
  if (totals.tests < 1) return `${script}: ran no tests`
  for (const key of ['skipped', 'todo', 'fail', 'cancelled']) if (totals[key]) return `${script}: ${totals[key]} ${key} (forbidden in required DB gates)`
  if (totals.pass !== totals.tests) return `${script}: passed count does not equal test count`
  return null
}

export function validateTarget(env) {
  if (!env.E2E_DATABASE_URL) throw new Error('Missing/invalid E2E_DATABASE_URL')
  if (!isE2eTarget(env.E2E_DATABASE_URL)) throw new Error(E2E_DB_RULE)
  for (const name of ['MIKKA_DATABASE_URL', 'DATABASE_URL']) if (env[name] !== env.E2E_DATABASE_URL) throw new Error(`${name} must match the ephemeral E2E_DATABASE_URL`)
  if (env.ORVILO_DATABASE_URL && env.ORVILO_DATABASE_URL !== env.E2E_DATABASE_URL) throw new Error('Legacy database fallback must not point outside ephemeral service')
}

// Shell steps of a package script: split on && / || / ; so a guard must sit on
// the same step that runs the guarded file, not merely somewhere in the script.
export const scriptSteps = command => (command ?? '').split(/&&|\|\||;/).map(step => step.trim()).filter(Boolean)

export function inventory(files, scripts, expected = [], required = REQUIRED_SUITES, selfManaged = SELF_MANAGED, offlineGuarded = OFFLINE_GUARDED) {
  const has = path => Object.hasOwn(files, path)
  const selected = new Set()
  const covered = new Set()
  const commandHas = (command, file) => command?.split(/\s+/).includes(file)
  const excluded = new Set()
  const browser = new Set()
  for (const { file, config, script } of BROWSER_SUITES) {
    if (!has(file) && !has(config) && !Object.hasOwn(scripts, script)) continue
    if (!has(file)) throw new Error(`Expected browser suite missing: ${file}`)
    if (!has(config)) throw new Error(`Browser suite ${file}: config ${config} missing`)
    if (!/^playwright\s+test\s/.test(scripts[script] ?? '') || !commandHas(scripts[script], `--config=${config}`)) throw new Error(`Browser script ${script} missing or no longer runs ${config}`)
    browser.add(file)
  }
  const offline = new Set()
  for(const {file,script,guard,reason} of offlineGuarded){
    if(!has(file))continue
    const rel=posix.relative(posix.dirname(file),guard)
    const localGuard=rel.startsWith('.')?rel:'./'+rel
    if(!reason||!has(guard)||!files[file].includes(`import '${localGuard}'`)||!scriptSteps(scripts[script]).some(step=>commandHas(step,file)&&step.split(/\s+/).some((t,i,a)=>t==='--import'&&a[i+1]===`./${guard}`)))throw Error(`Offline suite ${file} requires its source guard and explicit guarded pure script`)
    offline.add(file)
  }
  for (const { file, runner, reason } of selfManaged) {
    if (!has(file)) continue
    if (!reason) throw new Error(`Self-managed DB suite ${file} needs a reason`)
    if (!files[runner]?.includes(file)) throw new Error(`Self-managed DB suite ${file}: runner ${runner} missing or no longer runs it`)
    if (required.some(suite => suite.file === file)) throw new Error(`DB suite ${file} cannot be both required and self-managed`)
    excluded.add(file)
  }
  for (const file of SERVER_BACKED) {
    if (!has(file)) continue
    if (!files['scripts/run-factory-http-tests.mjs']?.includes(file) || scripts['test:factory-http'] !== 'node scripts/run-factory-http-tests.mjs') throw new Error(`Server-backed DB suite ${file} needs its actual-app runner`)
    excluded.add(file)
  }
  for (const { marker, file, script } of required) {
    if (!has(marker) && !has(file) && !expected.includes(script)) continue
    if (!has(file)) throw new Error(`Expected DB suite missing: ${file} (${marker})`)
    if (!commandHas(scripts[script], file)) throw new Error(`Required script ${script} missing or no longer runs ${file}`)
    selected.add(script); covered.add(file)
  }
  for (const [file, source] of Object.entries(files)) {
    // Playwright DB fixtures run in the preserved server-backed browser/performance gates.
    if (!/\.(test|spec)\.(ts|mjs|js)$/.test(file) || file === BOOTSTRAP || file === 'scripts/run-db-tests.test.mjs' || file.startsWith('tests/e2e/') || browser.has(file)) continue
    const runtimeSource = source.replace(/^\s*import\s+type\s+(?:\{[^}]*\}|[\w$]+)\s+from\s*['"]pg['"];?/gm, '')
    const databaseBacked = /(?:\.db\.test\.|-db\.test\.)/.test(file) || /(?:from\s*['"]pg['"]|import\(['"]pg['"]\)|REQUIRE_DB|CONVERSATION_READS_REQUIRE_DB)/.test(runtimeSource)
    if (!databaseBacked || covered.has(file) || excluded.has(file) || offline.has(file)) continue
    const matches = Object.entries(scripts).filter(([name, command]) => name.startsWith('test:') && commandHas(command, file))
    if (matches.length !== 1) throw new Error(`DB test ${file} needs one explicit package test script (found ${matches.length})`)
    selected.add(matches[0][0]); covered.add(file)
  }
  for (const name of expected) {
    if (!selected.has(name)) throw new Error(`Expected DB script not enrolled: ${name}`)
  }
  if (!selected.size) throw new Error('No database suites enrolled')
  return { scripts: [...selected].sort(), files: [...covered].sort(), selfManaged: [...excluded].sort(), browser: [...browser].sort(), offlineGuarded: [...offline].sort() }
}

export function readTree(root = '.') {
  const files = {}
  const walk = dir => {
    if (!existsSync(resolve(root, dir))) return
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const file = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(file)
      else if (/\.(ts|mjs|js)$/.test(file)) files[file] = readFileSync(resolve(root, file), 'utf8')
    }
  }
  walk('lib'); walk('tests'); walk('scripts')
  for (const { config } of BROWSER_SUITES) if (existsSync(resolve(root, config))) files[config] = readFileSync(resolve(root, config), 'utf8')
  return files
}

export function shardScripts(scripts, shard) {
  if (shard === undefined) return scripts
  const parts = typeof shard === 'string' && /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard)
  if (!parts || parts[0] !== shard) throw new Error('DB_TEST_SHARD must be i/n with 1 <= i <= n')
  const [index, count] = parts.slice(1).map(Number)
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) throw new Error('DB_TEST_SHARD must be i/n with 1 <= i <= n')
  const selected = [...scripts].sort().filter((_, position) => position % count === index - 1)
  if (!selected.length) throw new Error(`DB_TEST_SHARD ${shard} selects no database suites`)
  return selected
}

/** Selection narrows execution only after complete inventory validation. */
export function selectScripts(scripts, selection) {
  if (selection === undefined) return scripts
  const selected = JSON.parse(selection)
  if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length || selected.some(s => !scripts.includes(s))) throw Error('DB_TEST_SELECTED must be a nonempty unique subset of the complete inventory')
  return [...selected].sort()
}

// Suites that must run on the bootstrapped database itself rather than on a
// clone of it. They run one at a time, after every clone has been taken (a
// database can be a template only while nobody is connected to it).
export const TEMPLATE_BOUND = [
  { script: 'test:personal-mailbox-default-off-db', reason: 'loads MIKKA_TEST_ENVIRONMENT_FILE, whose descriptor and identity marker name the bootstrapped database' },
  { script: 'test:test-accounts-db', reason: 'loads MIKKA_TEST_ENVIRONMENT_FILE, whose descriptor and identity marker name the bootstrapped database' },
  { script: 'test:execution-settings-db', reason: 'asserts its connection is the database /mikka_e2e' },
  { script: 'test:approved-writes-db', reason: 'asserts every connection is 127.0.0.1:5432/mikka_e2e' },
  { script: 'test:factory-checks-db', reason: 'asserts its database is /mikka_e2e' },
  { script: 'test:ops-db', reason: 'asserts its database is /mikka_e2e or /mikka_transport_e2e' },
  { script: 'test:run-dispatch', reason: 'asserts its database is /mikka_e2e' },
]

/** The per-suite clone of `template` (a loopback *_e2e URL); <= 63 bytes and *_e2e itself. */
export function cloneDatabaseName(template, index, script) {
  const base = decodeURIComponent(new URL(template).pathname.slice(1)).replace(/_e2e$/, '')
  const prefix = `${base}_s${String(index).padStart(2, '0')}_`
  const slug = script.replace(/^test:/, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/_db$/, '')
  return `${prefix}${slug.slice(0, Math.max(0, 63 - prefix.length - 4))}_e2e`
}

export function databaseUrl(template, name) {
  const url = new URL(template)
  url.pathname = `/${name}`
  const value = url.toString()
  if (!isE2eTarget(value)) throw new Error(`Clone ${name}: ${E2E_DB_RULE}`)
  return value
}

/** Every variable that names the bootstrapped database (E2E_/MIKKA_/DATABASE_URL,
 * FACTORY_MONITOR_TEST_URL, ...) names the suite's own clone instead. */
export function suiteEnv(env, database) {
  const template = env.E2E_DATABASE_URL
  const next = { ...env }
  if (database) {
    const clone = databaseUrl(template, database)
    for (const [name, value] of Object.entries(env)) if (value === template) next[name] = clone
  }
  return { ...next, REQUIRE_DB: '1', CONVERSATION_READS_REQUIRE_DB: '1', MIKKA_TEST_DB_PORT: new URL(template).port || '5432' }
}

/** CREATE DATABASE <clone> TEMPLATE <bootstrapped>, from a separate *_e2e
 * control database so that nothing is connected to the template. `ready` is
 * called as each clone exists, so its suite can start while the rest are made. */
export async function createClones(template, names, ready = () => {}) {
  if (!names.length) return
  const { default: pg } = await import('pg')
  const source = decodeURIComponent(new URL(template).pathname.slice(1))
  const control = databaseUrl(template, `${source.replace(/_e2e$/, '')}_runner_e2e`)
  const quote = name => `"${name.replaceAll('"', '""')}"`
  const once = async (url, statements) => {
    const client = new pg.Client({ connectionString: url })
    await client.connect()
    try { for (const statement of statements) await client.query(statement) } finally { await client.end() }
  }
  const controlName = decodeURIComponent(new URL(control).pathname.slice(1))
  await once(template, [`DROP DATABASE IF EXISTS ${quote(controlName)} WITH (FORCE)`, `CREATE DATABASE ${quote(controlName)} TEMPLATE template0`])
  const client = new pg.Client({ connectionString: control })
  await client.connect()
  try {
    for (const name of names) {
      await client.query(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`)
      await client.query(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(source)}`)
      ready(name)
    }
  } finally { await client.end() }
}

// Progress is a bounded preview, never a second TAP summary or Actions command.
// Preserve the original bytes separately for the summary and final log group.
function progressText(value, limit = 512) {
  const safe = value.slice(0, limit)
    .replace(/\p{Cc}/gu, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
    .replace(/:{2,}/g, run => [...run].join(' ')).replaceAll('##[', '# #[')
  const suffix = ' [truncated]'
  return value.length > limit || safe.length > limit ? safe.slice(0, limit - suffix.length) + suffix : safe
}

/** Streams attributed previews while retaining the complete output and status. */
export function runScript(command, args, options) {
  return new Promise(resolvePromise => {
    const stdout = [], stderr = []
    const script = progressText(options.script ?? command, 120)
    const progress = (stream, line) => {
      const prefix = `[db-runner ${script} ${stream}] `
      process.stdout.write(prefix + progressText(line, 512 - prefix.length) + '\n')
    }
    let settled = false
    const done = result => { if (!settled) { settled = true; resolvePromise(result) } }
    progress('lifecycle', 'start')
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const [name, stream, buffer] of [['stdout', child.stdout, stdout], ['stderr', child.stderr, stderr]]) {
      stream.on('data', chunk => buffer.push(chunk))
      // readline decodes split UTF-8 and emits the final unterminated line too.
      createInterface({ input: stream, crlfDelay: Infinity, terminal: false }).on('line', line => progress(name, line))
    }
    child.on('error', error => done({ status: null, stdout: Buffer.concat(stdout).toString('utf8'), stderr: `${Buffer.concat(stderr).toString('utf8')}\n${error.message}` }))
    child.on('exit', (status, signal) => progress('lifecycle', `exit code=${status} signal=${signal ?? 'none'}`))
    child.on('close', (status, signal) => {
      progress('lifecycle', `close code=${status} signal=${signal ?? 'none'}`)
      done({ status, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    })
  })
}

export function concurrency(value, fallback = DEFAULT_CONCURRENCY) {
  if (value === undefined || value === '') return fallback
  if (!/^[1-9]\d?$/.test(value)) throw new Error('DB_TEST_CONCURRENCY must be an integer from 1 to 99')
  return Number(value)
}
// Measured on the 4-vCPU GitHub runner; see the pull request that set it.
export const DEFAULT_CONCURRENCY = 4

/** Test files a package script runs: a rough size, to start the largest suites first. */
export const suiteWeight = command => (command ?? '').split(/\s+/).filter(token => /\.(test|spec|db)\.(ts|mts|mjs|tsx|js)$|\.test\.|\.db\.ts$/.test(token)).length

export async function main({ root = '.', env = process.env, run = runScript, clone = createClones, now = () => Date.now() } = {}) {
  try {
    validateTarget(env)
    const limit = concurrency(env.DB_TEST_CONCURRENCY)
    const scripts = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).scripts ?? {}
    const plan = inventory(readTree(root), scripts, (env.DB_TEST_EXPECTED ?? '').split(',').filter(Boolean))
    console.log(`Required DB inventory: ${JSON.stringify(plan)}`)
    const selected = shardScripts(selectScripts(plan.scripts, env.DB_TEST_SELECTED), env.DB_TEST_SHARD)
    console.log(`Required DB selection: ${JSON.stringify({ shard: env.DB_TEST_SHARD ?? 'all', total: plan.scripts.length, scripts: selected })}`)
    // Suites share destructive fixtures, so each runs on its own copy of the
    // bootstrapped database; the few bound to that database by name run on it,
    // one at a time, once every copy has been taken.
    const bound = new Set(TEMPLATE_BOUND.map(entry => entry.script))
    const onTemplate = selected.filter(script => bound.has(script))
    const byWeight = (a, b) => b.weight - a.weight || (a.script < b.script ? -1 : 1)
    const isolated = selected.filter(script => !bound.has(script)).map(script => {
      let ready, failed
      const cloned = new Promise((resolvePromise, rejectPromise) => { ready = resolvePromise; failed = rejectPromise })
      cloned.catch(() => {})
      return { script, weight: suiteWeight(scripts[script]), database: cloneDatabaseName(env.E2E_DATABASE_URL, plan.scripts.indexOf(script), script), cloned, ready, failed }
    }).sort(byWeight)
    const cloning = now()
    const clones = Promise.resolve().then(() => clone(env.E2E_DATABASE_URL, isolated.map(suite => suite.database), name => isolated.find(suite => suite.database === name)?.ready()))
      .then(() => {
        for (const suite of isolated) suite.failed(new Error(`clone ${suite.database} was not created`))
        console.log(`Required DB clones: ${JSON.stringify({ template: new URL(env.E2E_DATABASE_URL).pathname.slice(1), clones: isolated.length, onTemplate, seconds: Math.round((now() - cloning) / 100) / 10 })}`)
      }, error => { for (const suite of isolated) suite.failed(error); throw error })
    clones.catch(() => {})
    let failed = false
    const timings = []
    const execute = async ({ script, database }) => {
      const started = now()
      const result = await run('pnpm', ['-s', script], { cwd: root, encoding: 'utf8', env: suiteEnv(env, database), maxBuffer: 64 << 20, script })
      const seconds = Math.round((now() - started) / 100) / 10
      timings.push({ script, seconds })
      console.log(`::group::pnpm ${script} (${database ?? 'template database'}, ${seconds}s)`)
      process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '')
      console.log('::endgroup::')
      const error = checkSummary(script, result.status, parseSummary(`${result.stdout}\n${result.stderr}`))
      if (error) { console.error(`::error::${error}`); failed = true }
      else console.log(`${script}: OK`)
    }
    const guarded = async (script, wait, body) => {
      try { await wait() } catch (error) { console.error(`::error::${script}: ${error.message}`); failed = true; return }
      await body()
    }
    // One serial lane for the template-bound suites, beside the clones, largest work first.
    const lanes = [
      ...(onTemplate.length ? [{ weight: onTemplate.reduce((sum, script) => sum + suiteWeight(scripts[script]), 0), script: '', start: () => guarded(onTemplate.join(','), () => clones, async () => { for (const script of onTemplate) await execute({ script }) }) }] : []),
      ...isolated.map(suite => ({ weight: suite.weight, script: suite.script, start: () => guarded(suite.script, () => suite.cloned, () => execute(suite)) })),
    ].sort(byWeight)
    const workers = Array.from({ length: Math.min(limit, lanes.length) }, async () => { while (lanes.length) await lanes.shift().start() })
    await Promise.all(workers)
    console.log(`Required DB timings: ${JSON.stringify({ shard: env.DB_TEST_SHARD ?? 'all', concurrency: limit, cpus: availableParallelism(), suites: timings.sort((a, b) => b.seconds - a.seconds) })}`)
    return failed ? 1 : 0
  } catch (error) { console.error(`::error::${error.message}`); return 1 }
}
// Let stdout/stderr drain: a failed suite can leave a large diagnostic buffer.
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().then(code => { process.exitCode = code })
