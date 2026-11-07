// Complete runtime receipts travel in immutable Actions artifacts, never in an
// environment variable, workflow input or argv. The small output hash binds the
// downloaded bytes; the manifest binds both candidate and consumer identities.
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const REPOSITORY = 'alexj11324/Mikka'
const KINDS = ['desktop', 'claude', 'codex']
const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9_-]{1,128}$/
const POSITIVE = /^[1-9][0-9]{0,19}$/
const fail = code => { throw Error(`runtime_handoff_${code}`) }
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function json(bytes) {
  try { return JSON.parse(bytes) } catch (cause) { throw Error('runtime_handoff_json_invalid', { cause }) }
}

function read(path) {
  try { return readFileSync(path) } catch (cause) { throw Error('runtime_handoff_file_unavailable', { cause }) }
}

function context(env) {
  if (env.GITHUB_REPOSITORY !== REPOSITORY || !SHA.test(env.GITHUB_SHA ?? '')
    || !POSITIVE.test(env.GITHUB_RUN_ID ?? '') || !POSITIVE.test(env.GITHUB_RUN_ATTEMPT ?? '')) fail('workflow_identity_invalid')
  return { repository: REPOSITORY, sourceCommit: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, producerAttempt: env.GITHUB_RUN_ATTEMPT }
}

function identities(report, origin, candidateAttempt) {
  if (report?.sourceCommit !== origin.sourceCommit || !SHA.test(report?.workerSha ?? '')
    || !POSITIVE.test(candidateAttempt ?? '') || BigInt(candidateAttempt) > BigInt(origin.producerAttempt)) fail('source_invalid')
  return Object.fromEntries(KINDS.map(kind => {
    const row = report.templates?.[kind]
    if (!ID.test(row?.templateId ?? '') || !ID.test(row?.buildId ?? '') || row?.baseTemplate !== kind || row.preinstalled !== true
      || row.name !== `mikka-${origin.sourceCommit.slice(0, 12)}-${origin.runId}-${candidateAttempt}-${kind}`) fail('candidate_identity_invalid')
    return [kind, { templateId: row.templateId, buildId: row.buildId }]
  }))
}

/** Earlier producer attempts are valid only inside the same run and source.
 * This lets rerun-failed-jobs consume the original immutable artifact. */
export function readHandoff(directory, stage, env = process.env) {
  const current = context(env), manifest = json(read(join(directory, 'handoff.json'))), bytes = read(join(directory, 'report.json'))
  if (!['candidates', 'release'].includes(stage) || manifest?.version !== 1 || manifest.stage !== stage
    || manifest.repository !== current.repository || manifest.sourceCommit !== current.sourceCommit || manifest.runId !== current.runId
    || !POSITIVE.test(manifest.producerAttempt ?? '') || BigInt(manifest.producerAttempt) > BigInt(current.producerAttempt)) fail('origin_invalid')
  if (!DIGEST.test(env.RUNTIME_REPORT_SHA256 ?? '') || manifest.reportSha256 !== env.RUNTIME_REPORT_SHA256
    || digest(bytes) !== manifest.reportSha256) fail('digest_mismatch')
  if (!SHA.test(env.RUNTIME_WORKER_SHA ?? '') || manifest.workerSha !== env.RUNTIME_WORKER_SHA) fail('worker_mismatch')
  const report = json(bytes), templates = identities(report, manifest, manifest.candidateAttempt)
  const expectedIds = json(env.RUNTIME_TEMPLATE_IDS ?? 'null')
  if (report.workerSha !== manifest.workerSha || !isDeepStrictEqual(templates, manifest.templates)
    || !isDeepStrictEqual(Object.fromEntries(KINDS.map(kind => [kind, templates[kind].templateId])), expectedIds)) fail('candidate_mismatch')
  if (stage === 'candidates' && (manifest.candidateAttempt !== manifest.producerAttempt || manifest.candidateReportSha256 !== manifest.reportSha256)) fail('candidate_origin_invalid')
  if (stage === 'release' && (!DIGEST.test(env.RUNTIME_CANDIDATE_REPORT_SHA256 ?? '')
    || manifest.candidateReportSha256 !== env.RUNTIME_CANDIDATE_REPORT_SHA256)) fail('candidate_digest_mismatch')
  return { report, manifest }
}

function writeHandoff(input, directory, stage, origin, candidate) {
  const bytes = read(input), report = json(bytes), candidateAttempt = candidate?.manifest.candidateAttempt ?? origin.producerAttempt
  const templates = identities(report, origin, candidateAttempt)
  if (stage === 'candidates') {
    for (const kind of KINDS) {
      const row = report.templates[kind], proof = row.conservation
      if (!Array.isArray(row.models) || !Number.isSafeInteger(proof?.before?.entries) || proof.before.entries <= 0
        || !DIGEST.test(proof.before.sha256 ?? '') || !isDeepStrictEqual(proof.before, proof.after)) fail('preservation_invalid')
    }
  } else {
    if (report.workerSha !== candidate.report.workerSha) fail('worker_mismatch')
    // Preserve the original catalogue and every conservation field. Only the
    // existing publish-verified operation may add these two public-state fields.
    for (const kind of KINDS) if (!isDeepStrictEqual(report.templates[kind], {
      ...candidate.report.templates[kind], public: true, buildStatus: 'ready',
    })) fail('release_candidate_changed')
  }
  const manifest = { version: 1, stage, ...origin, workerSha: report.workerSha, candidateAttempt,
    reportSha256: digest(bytes), candidateReportSha256: candidate?.manifest.reportSha256 ?? digest(bytes), templates }
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'report.json'), bytes, { mode: 0o600 })
  writeFileSync(join(directory, 'handoff.json'), JSON.stringify(manifest) + '\n', { mode: 0o600 })
  return { report, manifest }
}

export function packCandidates(input, directory, env = process.env) {
  return writeHandoff(input, directory, 'candidates', context(env))
}

export function packRelease(input, directory, candidateDirectory, env = process.env) {
  const candidate = readHandoff(candidateDirectory, 'candidates', env)
  return writeHandoff(input, directory, 'release', context(env), candidate)
}

export function handoffOutputs({ manifest }) {
  const ids = Object.fromEntries(KINDS.map(kind => [kind, manifest.templates[kind].templateId]))
  return `source-sha=${manifest.workerSha}\ntemplate-ids=${JSON.stringify(ids)}\nreport-sha256=${manifest.reportSha256}\n`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, input, directory, candidateDirectory] = process.argv.slice(2)
    let packed
    if (command === 'pack-candidates' && input && directory && !candidateDirectory) packed = packCandidates(input, directory)
    else if (command === 'pack-release' && input && directory && candidateDirectory) packed = packRelease(input, directory, candidateDirectory)
    else if (command === 'verify-candidates' && input && !directory) readHandoff(input, 'candidates')
    else fail('command_invalid')
    if (packed) appendFileSync(process.env.GITHUB_OUTPUT, handoffOutputs(packed))
  } catch (error) {
    // Never let a JSON parser's source excerpt or a filesystem error print the
    // receipt. The original cause remains available to the programmatic caller.
    console.error(/^runtime_handoff_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'runtime_handoff_failed')
    process.exitCode = 1
  }
}
