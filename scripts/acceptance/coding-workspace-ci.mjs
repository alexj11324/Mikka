/** #1721. Authenticate the existing runtime release and exact Web deployment
 * before the shared smoke-account credentials or a real repository task. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expectedRelease, verifyRelease } from './thread-lifecycle-ci.mjs'
import { waitForWebDeployment } from '../release/web-deploy.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const SHA = /^[a-f0-9]{40}$/
const CODES = new Set(['context', 'checkout', 'not_selected', 'runtime', 'web', 'attestation', 'report', 'incomplete', 'command', 'guard_failed'])
class WorkspaceCIError extends Error {
  constructor(code, cause) { super('coding_workspace_ci:' + code, cause === undefined ? undefined : { cause }); this.code = code }
}
const check = (ok, code) => { if (!ok) throw new WorkspaceCIError(code) }
export const safeWorkspaceCIFailure = error => error instanceof WorkspaceCIError && CODES.has(error.code) ? error.code : 'guard_failed'

/** Other owners' unrelated runtime releases must not create extra model work. */
export function codingWorkspaceChanged(files) {
  return files.some(path => path.startsWith('lib/coding-workspace/')
    || /^app\/(?:api\/runs\/\[runId\]\/workspace|v1\/devices\/\[deviceId\]\/workspace)\//.test(path)
    || path.startsWith('packages/daemon/src/coding-workspace/')
    || path === 'packages/protocol/src/coding-workspace.ts'
    || /^scripts\/acceptance\/coding-workspace(?:-ci)?(?:\.test)?\.mjs$/.test(path)
    || path === '.github/workflows/coding-workspace-acceptance.yml')
}

function checkout(sourceCommit) {
  check(SHA.test(sourceCommit ?? ''), 'context')
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  check(git(['rev-parse', 'HEAD']) === sourceCommit && git(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'checkout')
  const files = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', `${sourceCommit}^1`, sourceCommit, '--'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean)
  return { files, workerSha: () => {
    const hash = execFileSync('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', sourceCommit],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim()
    check(SHA.test(hash), 'checkout'); return hash
  } }
}

function directory(env) {
  check(typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP), 'report')
  const temp = realpathSync(env.RUNNER_TEMP), distance = relative(ROOT, temp)
  check(distance.startsWith('..' + sep) || isAbsolute(distance), 'report')
  const path = join(temp, 'coding-workspace-acceptance')
  mkdirSync(path, { recursive: true, mode: 0o700 })
  check(realpathSync(path) === path, 'report')
  return path
}
function readEvent(env) {
  check(typeof env.GITHUB_EVENT_PATH === 'string', 'context')
  const info = lstatSync(env.GITHUB_EVENT_PATH)
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= 2 * 1024 * 1024, 'context')
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
}
function write(env, name, value) {
  writeFileSync(join(directory(env), name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}
function output(env, name, value) {
  check(typeof env.GITHUB_OUTPUT === 'string' && /^[a-z-]+$/.test(name) && /^[a-z0-9_-]+$/.test(String(value)), 'context')
  appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

export function workspaceReleaseSelection(proof, files) {
  const relevant = codingWorkspaceChanged(files)
  // This acceptance is bound to the same newly published worker and Web SHA.
  // A skipped publication is not evidence of a new runtime. Static/DB coverage
  // still runs on every PR; unchanged-worker releases do not spend on this job.
  return { selected: relevant && proof.runtime === 'validated_and_published',
    reason: !relevant ? 'unrelated' : proof.runtime === 'validated_and_published' ? 'coding_workspace_runtime' : 'unchanged_worker' }
}

export function assertWorkspaceAttestation(expected, proof) {
  check(proof?.kind === 'coding-workspace-ci-attestation' && proof.selected === true
    && proof.runtime === 'validated_and_published' && proof.sourceCommit === expected.sourceCommit
    && proof.workerSourceCommit === expected.sourceCommit && SHA.test(proof.workerSha ?? '')
    && proof.upstream?.runId === expected.runId && proof.upstream?.runAttempt === expected.runAttempt
    && proof.upstream?.workflowId === expected.workflowId
    && proof.web?.sourceCommit === expected.sourceCommit && proof.web.publicBuild === expected.sourceCommit
    && Number.isSafeInteger(proof.web.webRunId) && proof.web.webRunId > 0
    && Number.isSafeInteger(proof.web.webAttempt) && proof.web.webAttempt > 0, 'attestation')
}

/** Rechecked immediately before each credential read and at driver entry. */
export async function attestWorkspaceAcceptance(env, { fetchImpl = fetch } = {}) {
  const event = readEvent(env), expected = expectedRelease(env, event), source = checkout(expected.sourceCommit)
  const before = await verifyRelease({ env, event, files: source.files, fetchImpl })
  check(workspaceReleaseSelection(before, source.files).selected, 'not_selected')
  const web = await waitForWebDeployment({ expectedBuild: expected.sourceCommit, token: env.GITHUB_TOKEN, fetchImpl })
  const after = await verifyRelease({ env, event, files: source.files, fetchImpl })
  check(workspaceReleaseSelection(after, source.files).selected, 'not_selected')
  const proof = { ...after, ...workspaceReleaseSelection(after, source.files), kind: 'coding-workspace-ci-attestation',
    workerSha: source.workerSha(), workerSourceCommit: expected.sourceCommit, web }
  assertWorkspaceAttestation(expected, proof)
  write(env, 'attestation.json', proof)
  return proof
}

export async function main(command, env = process.env) {
  check(['eligible', 'attest', 'run'].includes(command), 'command')
  if (command === 'eligible') {
    const event = readEvent(env), expected = expectedRelease(env, event), source = checkout(expected.sourceCommit)
    const proof = await verifyRelease({ env, event, files: source.files })
    const selection = workspaceReleaseSelection(proof, source.files)
    output(env, 'selected', selection.selected ? 'true' : 'false')
    console.log(JSON.stringify({ sourceCommit: expected.sourceCommit, ...selection }))
    return
  }
  const proof = await attestWorkspaceAcceptance(env)
  if (command === 'attest') {
    console.log(JSON.stringify({ sourceCommit: proof.sourceCommit, workerSha: proof.workerSha, upstream: proof.upstream, web: proof.web }))
    return
  }
  const { readOptions, runCodingWorkspaceAcceptance } = await import('./coding-workspace.mjs')
  const driverEnv = { ...env, EXPECTED_WORKER_SHA: proof.workerSha, EXPECTED_WORKER_SOURCE_SHA: proof.workerSourceCommit }
  const report = await runCodingWorkspaceAcceptance(readOptions(driverEnv), { env: driverEnv })
  write(env, 'report.json', report)
  // A second release attempt or main movement during the model work must not
  // turn an earlier attestation into a pass. Preserve the case/cleanup evidence
  // first, then mark this final binding failure explicitly.
  if (report.status === 'passed') {
    try { await attestWorkspaceAcceptance(env) }
    catch (error) {
      report.status = 'failed'
      report.releaseFailure = safeWorkspaceCIFailure(error)
      write(env, 'report.json', report)
      throw new WorkspaceCIError('attestation', error)
    }
  }
  console.log(JSON.stringify({ sourceCommit: proof.sourceCommit, status: report.status }))
  check(report.status === 'passed', 'incomplete')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => {
    console.error(JSON.stringify({ code: 'coding_workspace_ci', detail: safeWorkspaceCIFailure(error) }))
    process.exitCode = 1
  })
}
