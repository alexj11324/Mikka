// Complete preservation/subscription reports travel as immutable artifact files.
// Job outputs contain only their identity, digest and bounded cleanup metadata.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/
const NUMBER = /^[1-9][0-9]*$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
export const TEMPLATE_KINDS = ['desktop', 'claude', 'codex']
export const CLEANUP_IDENTITY_MAX_BYTES = 2048
const fail = code => { throw Error(code) }
const positive = value => typeof value === 'string' && NUMBER.test(value) && Number.isSafeInteger(Number(value))

export const reportDigest = bytes => createHash('sha256').update(bytes).digest('hex')
export const templateModels = report => Object.fromEntries(TEMPLATE_KINDS.map(kind => [kind, report.templates[kind].models]))
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
export const templateModelsDigest = report => reportDigest(JSON.stringify(canonical(templateModels(report))))

export function assertArtifactReference({ artifactId, sha256 }) {
  if (!positive(artifactId)) fail('runtime_report_artifact_id_invalid')
  if (typeof sha256 !== 'string' || !DIGEST.test(sha256)) fail('runtime_report_digest_invalid')
}

export function assertReportIdentity(report, { sourceCommit, workerSha, runId, runAttempt }) {
  if (!SHA.test(sourceCommit ?? '') || !SHA.test(workerSha ?? '') || !positive(runId) || !positive(runAttempt))
    fail('runtime_report_expected_identity_invalid')
  if (report?.sourceCommit !== sourceCommit || report?.workerSha !== workerSha)
    fail('runtime_report_source_mismatch')
  const ids = new Set()
  for (const kind of TEMPLATE_KINDS) {
    const row = report.templates?.[kind]
    if (row?.preinstalled !== true || typeof row?.buildId !== 'string' || !ID.test(row.buildId))
      fail('runtime_report_candidate_invalid')
    if (row?.baseTemplate !== kind || row.name !== `mikka-${sourceCommit.slice(0, 12)}-${runId}-${runAttempt}-${kind}`
      || typeof row.templateId !== 'string' || !ID.test(row.templateId) || ids.has(row.templateId))
      fail('runtime_report_attempt_mismatch')
    ids.add(row.templateId)
  }
}

export function readRuntimeReport(file, expected) {
  if (typeof expected.sha256 !== 'string' || !DIGEST.test(expected.sha256)) fail('runtime_report_digest_invalid')
  if (typeof file !== 'string' || !file) fail('runtime_report_file_required')
  let bytes
  try { bytes = readFileSync(file) } catch (cause) { throw Error('runtime_report_read_failed', { cause }) }
  if (reportDigest(bytes) !== expected.sha256) fail('runtime_report_digest_mismatch')
  let report
  try { report = JSON.parse(bytes) } catch (cause) { throw Error('runtime_report_json_invalid', { cause }) }
  assertReportIdentity(report, expected)
  return report
}

/** Subscription proof cannot rewrite any original candidate field. Publication
 * may only add the two public-state fields returned by publish-verified. */
export function assertCandidatePreserved(report, candidate, { published = false } = {}) {
  if (!SHA.test(candidate?.sourceCommit ?? '') || !SHA.test(candidate?.workerSha ?? '')
    || report?.sourceCommit !== candidate.sourceCommit || report?.workerSha !== candidate.workerSha)
    fail('runtime_report_candidate_changed')
  for (const kind of TEMPLATE_KINDS) {
    const row = candidate.templates?.[kind]
    if (!row || !isDeepStrictEqual(report.templates?.[kind], published ? { ...row, public: true, buildStatus: 'ready' } : row))
      fail('runtime_report_candidate_changed')
  }
  return report
}

/** Independent, small resource identities survive a failed report download.
 * They authorize only this run's cleanup; they never substitute for a gate. */
export function cleanupIdentity(report, expected) {
  assertReportIdentity(report, expected)
  const receipt = { version: 1, sourceCommit: expected.sourceCommit, runId: expected.runId, runAttempt: expected.runAttempt,
    templates: Object.fromEntries(TEMPLATE_KINDS.map(kind => {
      const row = report.templates[kind]
      return [kind, { baseTemplate: kind, name: row.name, templateId: row.templateId }]
    })) }
  const text = JSON.stringify(receipt)
  if (Buffer.byteLength(text) > CLEANUP_IDENTITY_MAX_BYTES) fail('runtime_report_cleanup_identity_too_large')
  return text
}

/** Workflow producer steps are synchronous. Report parsing causes stay inside
 * the process; only fixed transport codes are written to CI diagnostics. */
export function reportStep(operation) {
  try {
    return operation()
  } catch (error) {
    const codes = ['artifact_id_invalid', 'digest_invalid', 'file_required', 'read_failed', 'digest_mismatch',
      'json_invalid', 'expected_identity_invalid', 'source_mismatch', 'attempt_mismatch', 'candidate_invalid',
      'candidate_changed', 'preservation_invalid', 'command_invalid']
    const allowed = [...codes.map(value => `runtime_report_${value}`), 'runtime_release_models_digest_mismatch']
    const code = allowed.includes(error?.message) ? error.message : 'runtime_report_failed'
    console.error(JSON.stringify({ event: 'runtime_report_refused', code }))
    process.exitCode = 1
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  reportStep(() => {
    const reference = { artifactId: process.env.RUNTIME_REPORT_ARTIFACT_ID, sha256: process.env.RUNTIME_REPORT_SHA256 }
    assertArtifactReference(reference)
    if (process.argv[2] === 'verify') {
      const report = readRuntimeReport(process.argv[3], { sha256: reference.sha256, sourceCommit: process.env.GITHUB_SHA,
        workerSha: process.env.SOURCE_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })
      console.log(JSON.stringify({ event: 'runtime_report_verified', sourceCommit: report.sourceCommit, workerSha: report.workerSha, sha256: reference.sha256 }))
    } else if (process.argv[2] !== 'reference') fail('runtime_report_command_invalid')
  })
}
