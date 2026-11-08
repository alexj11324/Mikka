/** Read-only #1712 release attestation. No workflow reruns, writes or workload credentials. */
import { execFileSync } from 'node:child_process'
import { appendFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { expectedRelease, assertReleaseIdentity, selectRelease, REPOSITORY, RELEASE_NAME, RELEASE_WORKFLOW } from './thread-lifecycle-ci.mjs'
import { assertCurrentMain, PRODUCTION_VERSION_URL } from '../release/web-deploy.mjs'
import { assertReportIdentity, TEMPLATE_KINDS } from '../e2b/runtime-report.mjs'

export { REPOSITORY, RELEASE_NAME, RELEASE_WORKFLOW }
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
export const MAX_REPORT_BYTES = 32 * 1024 * 1024
const ROOT = resolve(import.meta.dirname, '../..')
const API = `https://api.github.com/repos/${REPOSITORY}`
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const number = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && positive(Number(value))
const hash = value => createHash('sha256').update(value).digest('hex')
const CODES = new Set(['context', 'factory_scope', 'checkout', 'jobs', 'artifact_missing', 'artifact_identity', 'artifact_size', 'artifact_digest',
  'artifact_redirect', 'artifact_archive', 'report', 'report_target', 'not_selected', 'attestation', 'public_build', 'github', 'command'])
class SecretCIError extends Error {
  constructor(code, cause) { super(`task_secret_ci:${code}`, cause === undefined ? undefined : { cause }); this.code = code }
}
const check = (ok, code) => { if (!ok) throw new SecretCIError(code) }
export const safeCIFailure = error => error instanceof SecretCIError && CODES.has(error.code) ? error.code : 'guard_failed'

function context(env) {
  check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/main'
    && ['workflow_run', 'workflow_dispatch'].includes(env.GITHUB_EVENT_NAME)
    && number(env.GITHUB_RUN_ID) && number(env.GITHUB_RUN_ATTEMPT), 'context')
  // There is no rerun API or self-trigger. A single automatic receiver permits
  // one explicit retry, with every source/attempt check performed again.
  if (env.GITHUB_EVENT_NAME === 'workflow_run') check(Number(env.GITHUB_RUN_ATTEMPT) <= 2, 'context')
}

/** A nearby documentation or unrelated runtime release never spends model calls.
 * A merge may contain documentation alongside one of these concrete sources. */
export function taskSecretsChanged(files) {
  check(Array.isArray(files) && files.length <= 10_000 && files.every(file => typeof file === 'string'
    && file.length <= 1000 && ![...file].some(character => character.charCodeAt(0) < 32)
    && !file.startsWith('/') && !file.split('/').includes('..')), 'checkout')
  return files.some(file => /^lib\/secrets\/(?:delivery(?:-http)?|egress-(?:capability|http|route)|task-(?:access|renewal)|runtime|run-invalidation|store|user-store|format)\.ts$/.test(file)
    || ['lib/db/secrets-schema.ts', 'lib/run-claim-response.ts', 'app/api/secrets/delivery/route.ts',
      'app/v1/task-secrets/[runId]/route.ts', 'app/v1/devices/[deviceId]/heartbeat/route.ts',
      'app/v1/devices/[deviceId]/runs/[runId]/claim/route.ts', 'packages/daemon/src/task-secret-bridge.ts',
      'packages/daemon/src/task-env.ts', 'packages/protocol/src/task-secrets.ts', 'packages/protocol/src/device.ts',
      '.github/workflows/task-secret-acceptance.yml'].includes(file)
    || /^scripts\/acceptance\/task-secrets(?:-[a-z-]+)?(?:\.test)?\.mjs$/.test(file))
}

export function selectTaskRelease(expected, data, files) {
  const release = selectRelease(expected, data, [])
  const relevant = taskSecretsChanged(files), published = release.runtime === 'validated_and_published'
  return { selected: relevant && published, status: relevant && !published ? 'blocked' : relevant ? 'selected' : 'skipped',
    reason: !relevant ? 'unrelated_source' : published ? 'secret_source_and_published_runtime' : 'runtime_not_validated_and_published',
    runtime: release.runtime, jobs: release.jobs }
}

async function readGithub(path, { token, fetchImpl = fetch }) {
  check(typeof token === 'string' && token.length > 0, 'context')
  try {
    const response = await fetchImpl(API + path, { headers: { accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' }, redirect: 'error', cache: 'no-store',
    signal: AbortSignal.timeout(20_000) })
    check(response.ok, 'github')
    return await response.json()
  } catch (cause) { throw new SecretCIError('github', cause) }
}

export function assertArtifactIdentity(expected, run, artifact, now = Date.now()) {
  const name = `e2b-release-evidence-${expected.runId}-${expected.runAttempt}`
  const created = Date.parse(artifact?.created_at), expires = Date.parse(artifact?.expires_at), started = Date.parse(run?.run_started_at)
  check(positive(artifact?.id) && artifact.name === name && artifact.expired === false
    && Number.isFinite(created) && Number.isFinite(expires) && Number.isFinite(started)
    && created >= started && created <= now + 60_000 && expires > now
    && positive(run.repository?.id) && run.head_repository?.id === run.repository.id
    && artifact.workflow_run?.id === expected.runId && artifact.workflow_run.repository_id === run.repository.id
    && artifact.workflow_run.head_repository_id === run.repository.id && artifact.workflow_run.head_branch === 'main'
    && artifact.workflow_run.head_sha === expected.sourceCommit
    && artifact.url === `${API}/actions/artifacts/${artifact.id}`
    && artifact.archive_download_url === `${API}/actions/artifacts/${artifact.id}/zip`, 'artifact_identity')
  check(positive(artifact.size_in_bytes) && artifact.size_in_bytes <= MAX_ARCHIVE_BYTES, 'artifact_size')
  check(typeof artifact.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(artifact.digest), 'artifact_digest')
  return { id: artifact.id, name, sha256: artifact.digest.slice(7), sizeBytes: artifact.size_in_bytes,
    createdAt: artifact.created_at, expiresAt: artifact.expires_at }
}

/** Same metadata/attempt fencing as thread-lifecycle-ci.verifyRelease, with a
 * narrower cost selector and a mandatory report from this exact publication. */
export async function verifyTaskRelease({ env, event, files, fetchImpl = fetch, now = Date.now }) {
  context(env)
  const expected = expectedRelease(env, event), options = { token: env.GITHUB_TOKEN, fetchImpl }
  const [workflow, run] = await Promise.all([readGithub('/actions/workflows/e2b-official-runtime.yml', options),
    readGithub(`/actions/runs/${expected.runId}`, options)])
  assertReleaseIdentity(expected, workflow, run)
  await assertCurrentMain({ expectedBuild: expected.sourceCommit, ...options })
  const data = await readGithub(`/actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`, options)
  const selection = selectTaskRelease(expected, data, files)
  const proof = { kind: 'task-secret-release-selection', sourceCommit: expected.sourceCommit,
    upstream: { runId: expected.runId, runAttempt: expected.runAttempt, workflowId: expected.workflowId },
    driver: { runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) }, ...selection }
  if (selection.selected) {
    const listing = await readGithub(`/actions/runs/${expected.runId}/artifacts?per_page=100`, options)
    check(Array.isArray(listing?.artifacts) && listing.total_count === listing.artifacts.length && listing.total_count <= 100, 'artifact_identity')
    const matches = listing.artifacts.filter(artifact => artifact.name === `e2b-release-evidence-${expected.runId}-${expected.runAttempt}`)
    check(matches.length === 1, 'artifact_missing')
    const listed = assertArtifactIdentity(expected, run, matches[0], now())
    const artifact = assertArtifactIdentity(expected, run, await readGithub(`/actions/artifacts/${listed.id}`, options), now())
    check(JSON.stringify(artifact) === JSON.stringify(listed), 'artifact_identity')
    proof.artifact = artifact
  }
  assertReleaseIdentity(expected, workflow, await readGithub(`/actions/runs/${expected.runId}`, options))
  await assertCurrentMain({ expectedBuild: expected.sourceCommit, ...options })
  return proof
}

export function artifactRedirect(value) {
  let url
  try { url = new URL(value) } catch (cause) { throw new SecretCIError('artifact_redirect', cause) }
  // Only the short-lived redirect returned by the authenticated GitHub API is
  // accepted. No webhook, artifact field, report or user input supplies a URL.
  check(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
      || /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname)), 'artifact_redirect')
  return url.href
}

async function boundedBytes(response, limit) {
  const length = response.headers.get('content-length')
  check(!length || /^\d+$/.test(length) && Number(length) <= limit, 'artifact_size')
  check(response.ok && response.body, 'github')
  const reader = response.body.getReader(), parts = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > limit) { await reader.cancel(); throw new SecretCIError('artifact_size') }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(parts)
}

/** Read only one bounded release.json member; never extract a ZIP path. */
export function archiveReport(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ARCHIVE_BYTES, 'artifact_size')
  const source = `import io, stat, sys, zipfile\nwith zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:\n    entries = archive.infolist()\n    assert len(entries) == 1\n    entry = entries[0]\n    assert entry.filename == 'release.json' and not entry.is_dir()\n    assert not (entry.flag_bits & 1) and not stat.S_ISLNK(entry.external_attr >> 16)\n    assert 0 < entry.file_size <= ${MAX_REPORT_BYTES}\n    assert entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)\n    data = archive.read(entry)\n    assert len(data) == entry.file_size\n    sys.stdout.buffer.write(data)\n`
  try { return execFileSync('python3', ['-c', source], { input: bytes, maxBuffer: MAX_REPORT_BYTES + 1024,
    timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (cause) { throw new SecretCIError('artifact_archive', cause) }
}

export async function downloadReleaseReport(proof, { token, fetchImpl = fetch }) {
  check(proof?.selected === true && positive(proof.artifact?.id) && DIGEST.test(proof.artifact.sha256 ?? ''), 'attestation')
  let response
  try {
    const redirect = await fetchImpl(`${API}/actions/artifacts/${proof.artifact.id}/zip`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    check(redirect.status === 302, 'artifact_redirect')
    const url = artifactRedirect(redirect.headers.get('location'))
    await redirect.body?.cancel()
    // The GitHub token is never forwarded to artifact storage.
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  } catch (cause) { throw new SecretCIError('artifact_redirect', cause) }
  const archive = await boundedBytes(response, MAX_ARCHIVE_BYTES)
  check(archive.length === proof.artifact.sizeBytes, 'artifact_size')
  check(hash(archive) === proof.artifact.sha256, 'artifact_digest')
  return archiveReport(archive)
}

export function releasePins(bytes, expected, workerSha) {
  check(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_REPORT_BYTES && SHA.test(workerSha ?? ''), 'report')
  let report
  try {
    report = JSON.parse(bytes)
    assertReportIdentity(report, { sourceCommit: expected.sourceCommit, workerSha,
      runId: String(expected.runId), runAttempt: String(expected.runAttempt) })
  } catch (cause) { throw new SecretCIError('report', cause) }
  check(TEMPLATE_KINDS.every(kind => report.templates[kind].public === true && report.templates[kind].buildStatus === 'ready'), 'report')
  for (const [kind, harness, model] of [['claude', 'claude_code', 'claude-haiku-5-5'], ['codex', 'codex', 'gpt-6-luna']]) {
    const row = report.subscriptionAcceptance?.[kind]
    check(row?.status === 'passed' && row.sourceCommit === expected.sourceCommit && row.workerSha === workerSha
      && row.templateId === report.templates[kind].templateId && row.harness === harness && row.model === model
      && row.credentialRoute === 'subscription' && row.replyVerified === true && row.replyVerifiedAfterTool === true, 'report')
  }
  return { workerSha, workerSourceCommit: expected.sourceCommit,
    templates: { claude_code: report.templates.claude.templateId, codex: report.templates.codex.templateId }, reportSha256: hash(bytes) }
}

export function assertDriverAttestation(env, proof) {
  context(env)
  check(env.GITHUB_EVENT_NAME === 'workflow_run' && proof?.kind === 'task-secret-ci-attestation' && proof.selected === true
    && proof.sourceCommit === env.EXPECTED_SOURCE_SHA && proof.sourceCommit === env.APPLICATION_SHA
    && proof.upstream?.runId === Number(env.EXPECTED_UPSTREAM_RUN_ID)
    && proof.upstream?.runAttempt === Number(env.EXPECTED_UPSTREAM_RUN_ATTEMPT)
    && positive(proof.upstream?.workflowId) && proof.driver?.runId === Number(env.GITHUB_RUN_ID)
    && proof.driver.runAttempt === Number(env.GITHUB_RUN_ATTEMPT)
    && proof.publicBuild === proof.sourceCommit && SHA.test(proof.sourceCommit ?? '')
    && proof.workerSha === env.EXPECTED_WORKER_SHA && SHA.test(proof.workerSha ?? '')
    && proof.workerSourceCommit === proof.sourceCommit && proof.workerSourceCommit === env.EXPECTED_WORKER_SOURCE_SHA
    && proof.templates?.claude_code === env.EXPECTED_CLAUDE_TEMPLATE && proof.templates?.codex === env.EXPECTED_CODEX_TEMPLATE
    && DIGEST.test(proof.reportSha256 ?? '') && positive(proof.artifact?.id) && DIGEST.test(proof.artifact.sha256 ?? '')
    && Object.values(proof.templates).every(value => /^[A-Za-z0-9_-]{1,128}$/.test(value)), 'attestation')
}

/** Reuse the existing Factory driver without its optional settings preparation,
 * browser actor or GitHub progress writer. Account identities are never aliased. */
export function factoryAcceptanceScope(env) {
  context(env)
  check(env.FACTORY_ACCEPTANCE_REQUESTED === 'true' && env.ACCEPTANCE_MODE === 'execute'
    && env.TASK_SECRETS_MODEL_CASE === 'all' && env.MIKKA_OBSERVABILITY_MODEL_CASE === 'all'
    && SHA.test(env.APPLICATION_SHA ?? '') && env.MIKKA_EXPECTED_DEPLOYMENT_SHA === env.APPLICATION_SHA
    && ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'MIKKA_ACCEPTANCE_PROGRESS_TOKEN', 'ACCEPTANCE_PREPARE',
      'ACCEPTANCE_BROWSER_SUBMIT', 'MIKKA_ACCEPTANCE_BASE_URL', 'REPLAY_SESSION_ID', 'REPLAY_TRACE_ID'].every(name => !env[name]), 'factory_scope')
  return { issue: 1712, sourceCommit: env.APPLICATION_SHA, driver: 'run-observability-workflow.mjs',
    account: 'existing_ACME_DEMO', modelCase: 'all', settingsPreparation: false, browserSubmission: false,
    githubComments: false, credentialOrAuthorizationChanges: false,
    workspaceSelection: 'switches_to_ACME_owner_personal_workspace_without_restoring_previous_selection',
    profileAndModelSelection: 'temporary_fixed_profile_and_model_with_existing_driver_cleanup',
    deliverable: 'artifact_only_no_repository_push_or_merge', required: 'execute_independent_review_artifact_bytes_owner_approval_accepted' }
}

function checkout(sourceCommit) {
  check(SHA.test(sourceCommit ?? ''), 'checkout')
  const git = args => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  check(git(['rev-parse', 'HEAD']) === sourceCommit && git(['status', '--porcelain=v1', '--untracked-files=all']) === '', 'checkout')
  const files = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', `${sourceCommit}^1`, sourceCommit, '--'],
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).split('\0').filter(Boolean)
  return { files, workerSha: () => {
    const value = execFileSync('python3', ['scripts/e2b/build-template.py', '--worker-hash', '--source-ref', sourceCommit],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim()
    check(SHA.test(value), 'checkout'); return value
  } }
}

function directory(env) {
  check(typeof env.RUNNER_TEMP === 'string' && isAbsolute(env.RUNNER_TEMP), 'report_target')
  const temp = realpathSync(env.RUNNER_TEMP), distance = relative(ROOT, temp)
  check(distance.startsWith(`..${sep}`) || isAbsolute(distance), 'report_target')
  const path = join(temp, 'task-secrets-ci')
  mkdirSync(path, { recursive: true, mode: 0o700 }); check(realpathSync(path) === path, 'report_target')
  return path
}
function readBounded(path, limit) {
  const info = lstatSync(path)
  check(info.isFile() && !info.isSymbolicLink() && info.size > 0 && info.size <= limit, 'report_target')
  return readFileSync(path)
}
function write(env, name, value) { writeFileSync(join(directory(env), name), value, { mode: 0o600 }) }
function writeProof(env, proof) { write(env, 'attestation.json', JSON.stringify(proof) + '\n') }
function output(env, key, value) {
  check(typeof env.GITHUB_OUTPUT === 'string' && env.GITHUB_OUTPUT.length > 0 && /^[a-z-]+$/.test(key)
    && /^[a-z0-9_-]+$/.test(String(value)), 'context')
  appendFileSync(env.GITHUB_OUTPUT, `${key}=${value}\n`)
}
async function publicBuild(sourceCommit, fetchImpl) {
  const response = await fetchImpl(PRODUCTION_VERSION_URL, { redirect: 'error', headers: { 'cache-control': 'no-store' },
    signal: AbortSignal.timeout(20_000) })
  check(response.ok && (await response.json()).build === sourceCommit, 'public_build')
  return sourceCommit
}
function event(env) { return JSON.parse(readBounded(env.GITHUB_EVENT_PATH, 2 * 1024 * 1024)) }

/** Re-run directly before each OIDC read and once more at driver entry. */
export async function attestAcceptance(env, { fetchImpl = fetch } = {}) {
  context(env)
  const sourceCommit = env.EXPECTED_SOURCE_SHA ?? env.APPLICATION_SHA
  const source = checkout(sourceCommit)
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    check(sourceCommit === env.GITHUB_SHA && env.APPLICATION_SHA === sourceCommit, 'context')
    await assertCurrentMain({ expectedBuild: sourceCommit, token: env.GITHUB_TOKEN, fetchImpl })
    const proof = { kind: 'task-secret-manual-attestation', sourceCommit, publicBuild: await publicBuild(sourceCommit, fetchImpl),
      driver: { runId: Number(env.GITHUB_RUN_ID), runAttempt: Number(env.GITHUB_RUN_ATTEMPT) } }
    await assertCurrentMain({ expectedBuild: sourceCommit, token: env.GITHUB_TOKEN, fetchImpl })
    writeProof(env, proof); return proof
  }
  const expected = expectedRelease(env, event(env))
  const selected = await verifyTaskRelease({ env, event: event(env), files: source.files, fetchImpl })
  check(selected.selected, 'not_selected')
  const saved = JSON.parse(readBounded(join(directory(env), 'prepared.json'), 32 * 1024))
  check(saved.sourceCommit === selected.sourceCommit && JSON.stringify(saved.upstream) === JSON.stringify(selected.upstream)
    && JSON.stringify(saved.artifact) === JSON.stringify(selected.artifact), 'attestation')
  const pins = releasePins(readBounded(join(directory(env), 'release.json'), MAX_REPORT_BYTES), expected, source.workerSha())
  check(pins.reportSha256 === saved.reportSha256, 'attestation')
  const proof = { ...selected, ...pins, kind: 'task-secret-ci-attestation', publicBuild: await publicBuild(sourceCommit, fetchImpl) }
  // Final source/attempt fence follows the public alias read, before workload credentials.
  const final = await verifyTaskRelease({ env, event: event(env), files: source.files, fetchImpl })
  check(final.selected && JSON.stringify(final.artifact) === JSON.stringify(selected.artifact), 'attestation')
  assertDriverAttestation(env, proof); writeProof(env, proof); return proof
}

async function main(command, env) {
  check(['eligible', 'prepare', 'attest'].includes(command), 'command'); context(env)
  const sourceCommit = env.EXPECTED_SOURCE_SHA ?? env.APPLICATION_SHA, source = checkout(sourceCommit)
  if (command === 'attest') { console.log(JSON.stringify(await attestAcceptance(env))); return }
  if (env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
    check(command === 'eligible' && sourceCommit === env.GITHUB_SHA && env.APPLICATION_SHA === sourceCommit, 'context')
    await assertCurrentMain({ expectedBuild: sourceCommit, token: env.GITHUB_TOKEN })
    output(env, 'selected', true); console.log(JSON.stringify({ kind: 'task-secret-selection', status: 'manual', selected: true, sourceCommit })); return
  }
  const selected = await verifyTaskRelease({ env, event: event(env), files: source.files })
  if (command === 'eligible') { output(env, 'selected', selected.selected); writeProof(env, selected); console.log(JSON.stringify(selected)); return }
  check(selected.selected, 'not_selected')
  const bytes = await downloadReleaseReport(selected, { token: env.GITHUB_TOKEN })
  const pins = releasePins(bytes, expectedRelease(env, event(env)), source.workerSha())
  write(env, 'release.json', bytes)
  write(env, 'prepared.json', JSON.stringify({ ...selected, ...pins }) + '\n')
  check(typeof env.GITHUB_ENV === 'string' && env.GITHUB_ENV.length > 0, 'context')
  appendFileSync(env.GITHUB_ENV, `APPLICATION_SHA=${sourceCommit}\nEXPECTED_WORKER_SHA=${pins.workerSha}\nEXPECTED_WORKER_SOURCE_SHA=${pins.workerSourceCommit}\nEXPECTED_CLAUDE_TEMPLATE=${pins.templates.claude_code}\nEXPECTED_CODEX_TEMPLATE=${pins.templates.codex}\n`)
  console.log(JSON.stringify({ ...selected, ...pins }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.length === 3 ? process.argv[2] : '', process.env).catch(error => {
    console.error(JSON.stringify({ kind: 'task-secret-ci', status: 'blocked', code: safeCIFailure(error) })); process.exitCode = 1
  })
}
