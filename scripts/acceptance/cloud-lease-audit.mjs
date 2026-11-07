import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { runCloudStartup } from './cloud-startup.mjs'
import { auditTarget } from './auth-audit-production.mjs'

export async function leaseAuditInstructions(sampleId, harness) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(sampleId) || !['claude_code', 'codex'].includes(harness)) throw Error('lease_audit_scope')
  const script = await readFile(new URL('./cloud-lease-probe.py', import.meta.url), 'utf8')
  return `Before the final reply, run the following exact Python script once inside your own VM using a shell tool, with a 600000ms timeout. It makes two legitimate requests only for this task's own subscription lease, waits for real expiry only when within nine minutes, and prints no credentials. Do not inspect or print the credential files yourself. Do not modify the script, shorten expiry, change daemon state, or retry. Wait for the shell process to finish; then reply STARTUP_OK_${sampleId}.\n\npython3 - <<'MIKKA_LEASE_PY'\n${script}\nmain(${JSON.stringify(`STARTUP_OK_${sampleId}`)}, ${JSON.stringify(harness)})\nMIKKA_LEASE_PY`
}

const statuses = new Set(['scope_refused', 'lease_refused', 'outside_natural_window', 'renewed', 'renewal_failed', 'probe_failed'])
/** Tool output only, not model prose. Never copy arbitrary output fields. */
export function leaseAuditReceipt(chunks, runId, harness) {
  const strings = (value, depth = 0) => depth > 5 ? [] : typeof value === 'string' ? [value]
    : Array.isArray(value) ? value.slice(0, 32).flatMap(item => strings(item, depth + 1))
      : value && typeof value === 'object' ? Object.values(value).slice(0, 32).flatMap(item => strings(item, depth + 1)) : []
  for (const item of chunks ?? []) {
    if (item.chunk?.type !== 'tool-output-available') continue
    for (const text of strings(item.chunk.output)) {
      if (text.length > 1000000) continue
      const match = /(?:^|\n)MIKKA_LEASE_AUDIT=(\{[^\n]+\})/.exec(text)
      if (!match) continue
      let value
      try { value = JSON.parse(match[1]) } catch { continue }
      if (value.runId !== runId || value.harness !== harness || !statuses.has(value.status)) continue
      const receipt = { status: value.status, valid: value.valid === true, naturalWindowObserved: value.naturalWindowObserved === true }
      for (const key of ['httpStatus', 'renewHttpStatus']) if (Number.isInteger(value[key]) && value[key] >= 100 && value[key] <= 599) receipt[key] = value[key]
      for (const key of ['expiresAt', 'renewExpiresAt']) if (Number.isSafeInteger(value[key]) && value[key] > 0) receipt[key] = value[key]
      receipt.renewValid = value.renewValid === true
      return receipt
    }
  }
  return { status: 'receipt_missing' }
}

export function naturalRenewalEvidence(sample) {
  const lease = sample.leaseAudit
  const renewals = sample.runtimeTiming?.counts?.filter(row => row.endpoint === 'credential_refresh') ?? []
  const observed = sample.daemonRenewal
  const traced = typeof sample.runId === 'string' && observed?.source === 'posthog_daemon_refresh_span'
    && observed.runIdHash === createHash('sha256').update(sample.runId).digest('hex').slice(0, 16)
    && observed.harness === sample.harness && observed.started > 0
    && observed.completed === observed.started && observed.errors === 0
    && sample.requireReplyAfterTool === true && sample.replyVerifiedAfterTool === true
    && ['succeeded', 'completed', 'stopped'].includes(sample.lastStatus)
  const timed = sample.runtimeTiming?.complete === true && sample.runtimeTiming.truncated === false
    && renewals.some(row => row.started > 0 && row.completed === row.started && row.errors === 0)
    && renewals.every(row => row.errors === 0)
  return lease?.status === 'renewed' && lease.valid && lease.renewValid && lease.naturalWindowObserved
    && lease.httpStatus === 200 && lease.renewHttpStatus === 200 && lease.renewExpiresAt > lease.expiresAt
    && (timed || traced)
}

/** Read only completed daemon refresh spans for this owned run's real expiry.
 * The Python tool's requests do not produce daemon.adapter.auth.refresh spans.
 * No performance opt-in, workspace variable, provider token or production write.
 */
export async function readDaemonRenewal(sample, { env = process.env, fetchImpl = fetch } = {}) {
  if (sample.leaseAudit?.status !== 'renewed') return undefined
  if (!/^[a-f0-9-]{36}$/.test(sample.runId ?? '') || !['claude_code', 'codex'].includes(sample.harness)
    || !Number.isSafeInteger(sample.leaseAudit.expiresAt) || sample.leaseAudit.expiresAt <= 60
    || !/^phx_[A-Za-z0-9_-]{8,}$/.test(env.POSTHOG_PERSONAL_API_KEY ?? '')) throw Error('lease_audit_trace_scope')
  const runIdHash = createHash('sha256').update(sample.runId).digest('hex').slice(0, 16)
  const expiry = sample.leaseAudit.expiresAt
  const query = `SELECT uniqExact(span_id),
    uniqExactIf(span_id, status_code != 2 AND attributes['mikka.outcome'] = 'ok'),
    uniqExactIf(span_id, status_code = 2 OR attributes['mikka.outcome'] != 'ok')
    FROM posthog.trace_spans WHERE service_name = 'mikka-daemon'
    AND coalesce(nullIf(resource_attributes['deployment.environment.name'], ''), resource_attributes['deployment.environment']) = 'production'
    AND name = 'daemon.adapter.auth.refresh' AND attributes['mikka.run.id_hash'] = '${runIdHash}'
    AND attributes['mikka.harness'] = '${sample.harness}'
    AND timestamp >= toDateTime(${expiry - 60}) AND timestamp <= toDateTime(${expiry + 30}) LIMIT 1`
  const response = await fetchImpl('https://us.posthog.com/api/projects/670821/query/', {
    method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${env.POSTHOG_PERSONAL_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query }, refresh: 'force_blocking' }), signal: AbortSignal.timeout(30000),
  })
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw Error(`lease_audit_trace_http_${response.status}`)
  }
  const value = await response.json(), row = value?.results?.[0]
  if (value?.results?.length !== 1 || !Array.isArray(row) || row.length !== 3
    || !row.every(count => Number.isSafeInteger(count) && count >= 0 && count <= 1000)
    || row[1] + row[2] !== row[0]) throw Error('lease_audit_trace_invalid')
  return { source: 'posthog_daemon_refresh_span', runIdHash, harness: sample.harness,
    started: row[0], completed: row[1], errors: row[2] }
}

export async function runLeaseAudit(env = process.env, { runStartup = runCloudStartup, readRenewal = readDaemonRenewal } = {}) {
  const applicationSha = auditTarget(env)
  const report = await runStartup({ origin: 'https://app.aspectlylabs.com', runs: 2, harness: 'both',
    mode: 'candidate', strategy: 'derived', revision: applicationSha, expectedBuild: applicationSha,
    timeoutMs: 600000, maxStartupMs: 60000, runtimeEvidence: 'optional', officialTiming: 'disabled', leaseAudit: true }, { env })
  for (const sample of report.samples) {
    try { sample.daemonRenewal = await readRenewal(sample, { env }) }
    catch (error) {
      const match = /^lease_audit_trace_http_([45][0-9]{2})$/.exec(error?.message ?? '')
      sample.daemonRenewal = { source: 'posthog_daemon_refresh_span', status: 'unavailable', ...(match ? { httpStatus: Number(match[1]) } : {}) }
    }
  }
  const samples = report.samples.map(sample => ({ harness: sample.harness, model: sample.requestedModel,
    runId: sample.runId, status: sample.status, failure: sample.failure, cleanup: sample.cleanup,
    lease: sample.leaseAudit, naturalRenewalVerified: naturalRenewalEvidence(sample),
    daemonRenewal: sample.daemonRenewal,
    credentialRefresh: sample.runtimeTiming?.counts?.filter(row => row.endpoint === 'credential_refresh') ?? [] }))
  return { issue: 1598, applicationSha, startedAt: report.startedAt, finishedAt: report.finishedAt,
    status: report.status !== 'candidate_subscription_proved' || report.cleanup.errors.length || samples.length !== 2
      || samples.some(sample => !sample.naturalRenewalVerified || sample.status !== 'execution_proved_awaiting_server_timing'
        || sample.cleanup?.status !== 'passed') ? 'blocked' : 'passed',
    failure: report.failure, samples, cleanup: report.cleanup }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let report
  try { report = await runLeaseAudit() } catch { report = { issue: 1598, status: 'blocked', error: 'lease_audit_failed' } }
  await mkdir('production-lease-audit-report', { recursive: true })
  await writeFile('production-lease-audit-report/report.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (report.status !== 'passed') process.exitCode = 1
}
