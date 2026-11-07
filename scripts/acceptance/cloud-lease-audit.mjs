import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
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
  return lease?.status === 'renewed' && lease.valid && lease.renewValid && lease.naturalWindowObserved
    && lease.httpStatus === 200 && lease.renewHttpStatus === 200 && lease.renewExpiresAt > lease.expiresAt
    && sample.runtimeTiming?.complete === true && sample.runtimeTiming.truncated === false
    && renewals.some(row => row.started > 0 && row.completed === row.started && row.errors === 0)
    && renewals.every(row => row.errors === 0)
}

export async function runLeaseAudit(env = process.env) {
  const applicationSha = auditTarget(env)
  const report = await runCloudStartup({ origin: 'https://app.aspectlylabs.com', runs: 2, harness: 'both',
    mode: 'candidate', strategy: 'derived', revision: applicationSha, expectedBuild: applicationSha,
    timeoutMs: 720000, maxStartupMs: 60000, runtimeEvidence: 'required', officialTiming: 'enabled', leaseAudit: true })
  const samples = report.samples.map(sample => ({ harness: sample.harness, model: sample.requestedModel,
    runId: sample.runId, status: sample.status, failure: sample.failure, cleanup: sample.cleanup,
    lease: sample.leaseAudit, naturalRenewalVerified: naturalRenewalEvidence(sample),
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
