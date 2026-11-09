import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { smokeSession, SMOKE_ID } from './http.ts'
import { factoryCriteria } from '../../../lib/factory/task-detail.ts'
import { runCriterion } from '@mikka/protocol/run'
import { redactFactoryCheckText } from '../../../lib/factory/checks.ts'
import { EXTERNAL_CRITERIA, IMPLEMENTATION_CRITERION } from './fixture-ci-evidence.mjs'

const AUDITED_APPS = ['a2198c8c2f608f7b8169329b9da853067618dba6', 'e78fccffd9dd878edd490b113ea80efcff1525e7'] as const
const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const TASK = 'c687460b-e6a4-44ac-8696-f60d66bf64d3'
const REVIEW = '51f9f9b1-cabd-4530-8147-93c58f9d5ecf'
const report: any = {
  issue: 1503, phase: 'read_only_diagnosis_42606137512', acceptancePassed: false,
  auditedAppsWithIdenticalFactoryBackend: [...AUDITED_APPS], failedFSource: '8fce8f9885fc5edddbc1733063576fd972ea9611',
  failedFRunId: 42606137512, failedFAttempt: 1,
  operatorSha: process.env.GITHUB_SHA ?? null,
  marker: (process.env.GITHUB_RUN_ID ?? '') + '-' + (process.env.GITHUB_RUN_ATTEMPT ?? ''),
  startedAt: new Date().toISOString(), normalReads: {}, status: 'started',
}
const hash = (x: unknown) => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex')
const stringInfo = (x: unknown) => ({ type: typeof x, nonempty: typeof x === 'string' && x.trim().length > 0,
  length: typeof x === 'string' ? x.length : null, sha256: typeof x === 'string' ? hash(x) : null })
const safeText = (x: unknown) => typeof x === 'string' ? redactFactoryCheckText(x).slice(0, 2000)
  .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]')
  .replace(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/gi, '[redacted-id]') : null
const label = (x: unknown) => typeof x === 'string' ? x.trim() : ''
let session: Awaited<ReturnType<typeof smokeSession>> | null = null
try {
  session = await smokeSession()
  if (session.user.id !== SMOKE_ID) throw new Error('issue1503_diagnostic_identity_mismatch')
  const build = await session.json('/api/version')
  report.productionBefore = build.build
  if (!(AUDITED_APPS as readonly string[]).includes(build.build)) throw new Error('issue1503_diagnostic_source_changed')
  const read = async (name: string, path: string) => {
    report.normalReads[name] = (report.normalReads[name] ?? 0) + 1
    const response = await session!.request(path, { headers: { cookie: 'mikka-workspace=' + WORKSPACE, 'x-mikka-locale': 'en' } })
    const value = await response.json().catch(() => null)
    report[name + 'Http'] = { status: response.status, ok: response.ok,
      error: typeof value?.error === 'string' && /^[A-Za-z][A-Za-z0-9_]{1,100}$/.test(value.error) ? value.error : null }
    return response.ok ? value : null
  }
  // This exact normal review-artifact read was after the failed gate in F and
  // did not execute there. Preserve it once; no task-state read or SQL is added.
  const artifact = await read('reviewArtifact', '/api/factory/tasks/' + TASK + '/approval?artifact=' + encodeURIComponent('run-report:' + REVIEW))
  if (artifact) {
    const ref = artifact.ref ?? {}
    const raw = artifact.raw ?? {}
    const criteria = Array.isArray(raw.criteria) ? raw.criteria : []
    const projected = factoryCriteria(raw)
    report.artifact = {
      ref: Object.fromEntries(['artifact','kind','runId','candidateId','sha','environment','recordedAt'].map(k => [k, ref[k] ?? null])),
      sourceSha256: artifact.sourceSha256 ?? null,
      sourceTime: artifact.sourceTime ?? null, startedAt: artifact.startedAt ?? null, finishedAt: artifact.finishedAt ?? null,
      returnedRawSha256: hash(raw), rawKeys: Object.keys(raw),
      checkSha: raw.check?.sha ?? null, readOnly: raw.check?.readOnly ?? null,
      filesChangedCount: Array.isArray(raw.filesChanged) ? raw.filesChanged.length : null,
      reviewVerdict: raw.reviewVerdict ?? null,
      criteriaArray: Array.isArray(raw.criteria), criteriaCount: criteria.length, overflow: criteria.length > 200,
      projectedCount: projected.length,
      criteria: criteria.slice(0, 201).map((c: any, ordinal: number) => {
        const parsed = runCriterion.safeParse(c)
        const one = factoryCriteria({ ...raw, criteria: [c] })[0]
        const t = label(c?.text)
        return { ordinal, keys: c && typeof c === 'object' && !Array.isArray(c) ? Object.keys(c) : [],
          schemaValid: parsed.success, schemaIssues: parsed.success ? [] : parsed.error.issues.map(x => ({ code: x.code, path: x.path.map(String).join('.') })),
          criterionIdType: typeof c?.criterionId, criterionIdUuid: typeof c?.criterionId === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(c.criterionId),
          text: safeText(c?.text), textInfo: stringInfo(c?.text),
          passed: typeof c?.passed === 'boolean' ? c.passed : null,
          rawStatus: ['passed','failed','unverified'].includes(c?.status) ? c.status : null,
          projectedStatus: one?.status ?? null,
          evidenceInfo: stringInfo(c?.evidence), reason: safeText(c?.reason), reasonInfo: stringInfo(c?.reason),
          resolutionInfo: stringInfo(c?.resolution), commandInfo: stringInfo(c?.command),
          exitCode: Number.isSafeInteger(c?.exitCode) ? c.exitCode : null,
          exactImplementationLabel: t === IMPLEMENTATION_CRITERION,
          exactCiLabel: Object.prototype.hasOwnProperty.call(EXTERNAL_CRITERIA, t),
        }
      }),
    }
  }
  // The existing account-settings read identifies which normal sign-in methods
  // are linked. Record provider names only; never account IDs, email or tokens.
  const accounts = await read('linkedAccounts', '/api/auth/list-accounts')
  if (Array.isArray(accounts)) report.linkedProviders = accounts.map((a: any) => a?.providerId)
    .filter((p: unknown) => typeof p === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(p as string)).sort()
  report.productionAfter = (await session.json('/api/version')).build
  report.sourceUnchangedDuringReads = report.productionAfter === report.productionBefore
  if (!(AUDITED_APPS as readonly string[]).includes(report.productionAfter)) throw new Error('issue1503_diagnostic_source_changed')
  report.status = artifact && Array.isArray(accounts) ? 'collected' : 'collected_with_normal_refusal'
} catch (error) {
  const message = error instanceof Error ? error.message : ''
  report.status = 'failed'
  report.code = /^issue1503_[a-zA-Z0-9_]+$/.test(message) ? message : 'issue1503_diagnostic_failed'
  process.exitCode = 1
} finally {
  if (session) {
    try { await session.close(); report.normalSessionClosed = true }
    catch { report.normalSessionClosed = false; report.sessionCloseFailed = true; report.status = 'failed'; report.code ??= 'issue1503_diagnostic_session_close_failed'; process.exitCode = 1 }
  }
  report.completedAt = new Date().toISOString()
  await mkdir('issue1503-report', { recursive: true })
  await writeFile('issue1503-report/diagnosis-42606137512.json', JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ issue: 1503, phase: report.phase, status: report.status, acceptancePassed: false, normalReads: report.normalReads }))
}
