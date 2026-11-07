// Full conservation and subscription receipts travel as immutable artifact
// files. Job outputs carry only this file's digest and the artifact's ID.
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[a-f0-9]{40}$/
const DIGEST = /^[a-f0-9]{64}$/
const NUMBER = /^[1-9][0-9]{0,19}$/
const KINDS = ['desktop', 'claude', 'codex']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const check = (value, code) => { if (!value) throw Error(`runtime_report_${code}`) }

export function assertRuntimeArtifactReference({ artifactId, sha256, workerSha }) {
  check(NUMBER.test(artifactId ?? '') && DIGEST.test(sha256 ?? '') && SHA.test(workerSha ?? ''), 'reference_invalid')
}

export function runtimeModelsSha256(report) {
  const models = KINDS.map(kind => [kind, report.templates[kind].models])
  // Preserve the old deep-value comparison, independent of object key order.
  return hash(JSON.stringify(models, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value))
}

function identify(bytes, env, workerSha) {
  check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && SHA.test(env.GITHUB_SHA ?? '')
    && NUMBER.test(env.GITHUB_RUN_ID ?? '') && NUMBER.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'workflow_invalid')
  let report
  try { report = JSON.parse(bytes) } catch (cause) { throw Error('runtime_report_json_invalid', { cause }) }
  check(report?.sourceCommit === env.GITHUB_SHA && SHA.test(report.workerSha ?? '')
    && (workerSha === undefined || SHA.test(workerSha) && report.workerSha === workerSha), 'source_mismatch')
  for (const kind of KINDS) {
    const row = report.templates?.[kind]
    const name = new RegExp(`^mikka-${env.GITHUB_SHA.slice(0, 12)}-${env.GITHUB_RUN_ID}-([1-9][0-9]{0,19})-${kind}$`)
    const match = name.exec(row?.name ?? '')
    // A failed-job rerun may consume the immutable build artifact from an
    // earlier attempt of this same run; never another source/run or future.
    check(row?.baseTemplate === kind && row.preinstalled === true
      && /^[A-Za-z0-9_-]+$/.test(row?.templateId ?? '') && match
      && BigInt(match[1]) <= BigInt(env.GITHUB_RUN_ATTEMPT), 'candidate_identity_mismatch')
  }
  return report
}

export function sealRuntimeReport(file, { env = process.env } = {}) {
  const bytes = readFileSync(file), report = identify(bytes, env)
  return { report, sha256: hash(bytes), bytes: bytes.length, modelsSha256: runtimeModelsSha256(report) }
}

export function readRuntimeReport(file, { sha256, workerSha, env = process.env } = {}) {
  check(DIGEST.test(sha256 ?? ''), 'digest_required')
  const bytes = readFileSync(file)
  check(hash(bytes) === sha256, 'digest_mismatch')
  return identify(bytes, env, workerSha)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [command, file] = process.argv.slice(2)
    check(command === 'reference' || file && ['seal', 'verify'].includes(command), 'command_invalid')
    if (command === 'reference') {
      assertRuntimeArtifactReference({ artifactId: process.env.RUNTIME_ARTIFACT_ID,
        sha256: process.env.RUNTIME_REPORT_SHA256, workerSha: process.env.RUNTIME_WORKER_SHA })
    } else if (command === 'seal') {
      const { report, sha256, bytes, modelsSha256 } = sealRuntimeReport(file)
      check(process.env.GITHUB_OUTPUT, 'output_required')
      appendFileSync(process.env.GITHUB_OUTPUT, `report-sha256=${sha256}\nworker-sha=${report.workerSha}\nmodels-sha256=${modelsSha256}\n`)
      console.log(JSON.stringify({ event: 'runtime_report_sealed', bytes, sha256, sourceCommit: report.sourceCommit }))
    } else {
      const report = readRuntimeReport(file, { sha256: process.env.RUNTIME_REPORT_SHA256, workerSha: process.env.RUNTIME_WORKER_SHA })
      console.log(JSON.stringify({ event: 'runtime_report_verified', sourceCommit: report.sourceCommit, workerSha: report.workerSha }))
    }
  } catch (error) {
    // JSON, filesystem or provider evidence must never be dumped as an error.
    console.error(/^runtime_report_[a-z_]+$/.test(error?.message ?? '') ? error.message : 'runtime_report_failed')
    process.exitCode = 1
  }
}
