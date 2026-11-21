// Complete runtime publication reports travel as immutable artifact files.
// Job outputs contain only their identity, digest and bounded cleanup metadata.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { officialMikkaRepository, publicRepositoryId } from '../cloudflare-source.mjs'

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

// The original Task Secret artifact reader is shared here so source consumers
// use one bounded transport/ZIP implementation without mutual consumer imports.
// Preserve its historical error prefix and closed code ABI for existing callers.
export class RuntimeArtifactError extends Error {
  constructor(code, cause) { super(`task_secret_ci:${code}`, cause === undefined ? undefined : { cause }); this.code = code }
}
export const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
export const MAX_REPORT_BYTES = 32 * 1024 * 1024
const artifactId = value => Number.isSafeInteger(value) && value > 0
const artifactCheck = (ok, code) => { if (!ok) throw new RuntimeArtifactError(code) }

export function assertArtifactIdentity(expected, run, artifact, now = Date.now()) {
  // The caller binds these fields after its official-run API check. Artifact
  // metadata cannot choose a repository or supply the authenticated download URL.
  const repository = expected?.repositoryFullName
  artifactCheck(artifactId(expected?.repositoryId)
    && officialMikkaRepository(repository, String(expected.repositoryId)), 'artifact_identity')
  const api = `https://api.github.com/repos/${repository}`
  const name = `e2b-release-evidence-${expected.runId}-${expected.runAttempt}`
  const created = Date.parse(artifact?.created_at), expires = Date.parse(artifact?.expires_at), started = Date.parse(run?.run_started_at)
  artifactCheck(artifactId(artifact?.id) && artifact.name === name && artifact.expired === false
    && Number.isFinite(created) && Number.isFinite(expires) && Number.isFinite(started)
    && created >= started && created <= now + 60_000 && expires > now
    && run.repository?.id === expected.repositoryId && run.head_repository?.id === expected.repositoryId
    && run.repository?.full_name === repository && run.head_repository?.full_name === repository
    && artifact.workflow_run?.id === expected.runId && artifact.workflow_run.repository_id === expected.repositoryId
    && artifact.workflow_run.head_repository_id === expected.repositoryId && artifact.workflow_run.head_branch === 'main'
    && artifact.workflow_run.head_sha === expected.sourceCommit
    && artifact.url === `${api}/actions/artifacts/${artifact.id}`
    && artifact.archive_download_url === `${api}/actions/artifacts/${artifact.id}/zip`, 'artifact_identity')
  artifactCheck(artifactId(artifact.size_in_bytes) && artifact.size_in_bytes <= MAX_ARCHIVE_BYTES, 'artifact_size')
  artifactCheck(typeof artifact.digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(artifact.digest), 'artifact_digest')
  return { id: artifact.id, repositoryId: expected.repositoryId, name, sha256: artifact.digest.slice(7), sizeBytes: artifact.size_in_bytes,
    createdAt: artifact.created_at, expiresAt: artifact.expires_at }
}

export function artifactRedirect(value) {
  let url
  try { url = new URL(value) } catch (cause) { throw new RuntimeArtifactError('artifact_redirect', cause) }
  // Only the short-lived redirect returned by the authenticated GitHub API is
  // accepted. No webhook, artifact field, report or user input supplies a URL.
  artifactCheck(url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash
    && (/^productionresultssa[0-9]+\.blob\.core\.windows\.net$/.test(url.hostname)
      || /^[a-z0-9-]+\.actions\.githubusercontent\.com$/.test(url.hostname)), 'artifact_redirect')
  return url.href
}

async function boundedBytes(response, limit) {
  const length = response.headers.get('content-length')
  artifactCheck(!length || /^\d+$/.test(length) && Number(length) <= limit, 'artifact_size')
  artifactCheck(response.ok && response.body, 'github')
  const reader = response.body.getReader(), parts = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.length
      if (size > limit) { await reader.cancel(); throw new RuntimeArtifactError('artifact_size') }
      parts.push(part.value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(parts)
}

/** Read only one bounded release.json member; never extract a ZIP path. */
export function archiveReport(bytes) {
  artifactCheck(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= MAX_ARCHIVE_BYTES, 'artifact_size')
  const source = `import io, stat, sys, zipfile\nwith zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:\n    entries = archive.infolist()\n    assert len(entries) == 1\n    entry = entries[0]\n    assert entry.filename == 'release.json' and not entry.is_dir()\n    assert not (entry.flag_bits & 1) and not stat.S_ISLNK(entry.external_attr >> 16)\n    assert 0 < entry.file_size <= ${MAX_REPORT_BYTES}\n    assert entry.compress_type in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED)\n    data = archive.read(entry)\n    assert len(data) == entry.file_size\n    sys.stdout.buffer.write(data)\n`
  try { return execFileSync('python3', ['-c', source], { input: bytes, maxBuffer: MAX_REPORT_BYTES + 1024,
    timeout: 20_000, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (cause) { throw new RuntimeArtifactError('artifact_archive', cause) }
}

export async function downloadReleaseReport(proof, { token, fetchImpl = fetch }) {
  artifactCheck(proof?.selected === true && artifactId(proof.artifact?.id) && proof.artifact.repositoryId === Number(publicRepositoryId)
    && DIGEST.test(proof.artifact.sha256 ?? ''), 'attestation')
  let response
  try {
    const redirect = await fetchImpl(`https://api.github.com/repositories/${proof.artifact.repositoryId}/actions/artifacts/${proof.artifact.id}/zip`, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    artifactCheck(redirect.status === 302, 'artifact_redirect')
    const url = artifactRedirect(redirect.headers.get('location'))
    await redirect.body?.cancel()
    // The GitHub token is never forwarded to artifact storage.
    response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) })
  } catch (cause) { throw new RuntimeArtifactError('artifact_redirect', cause) }
  const archive = await boundedBytes(response, MAX_ARCHIVE_BYTES)
  artifactCheck(archive.length === proof.artifact.sizeBytes, 'artifact_size')
  artifactCheck(reportDigest(archive) === proof.artifact.sha256, 'artifact_digest')
  return archiveReport(archive)
}

/** Keep listing/detail identity coherent before the existing bounded download. */
export async function readReleaseArtifact(expected, run, { read, now = Date.now }) {
  artifactCheck(artifactId(expected?.runId) && artifactId(expected?.runAttempt), 'artifact_identity')
  const listing = await read(`/actions/runs/${expected.runId}/artifacts?per_page=100`)
  artifactCheck(Array.isArray(listing?.artifacts) && listing.total_count === listing.artifacts.length && listing.total_count <= 100, 'artifact_identity')
  const matches = listing.artifacts.filter(artifact => artifact.name === `e2b-release-evidence-${expected.runId}-${expected.runAttempt}`)
  artifactCheck(matches.length === 1, 'artifact_missing')
  const listed = assertArtifactIdentity(expected, run, matches[0], now())
  const artifact = assertArtifactIdentity(expected, run, await read(`/actions/artifacts/${listed.id}`), now())
  artifactCheck(JSON.stringify(artifact) === JSON.stringify(listed), 'artifact_identity')
  return artifact
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
      const report = readRuntimeReport(process.argv[3], { sha256: reference.sha256, sourceCommit: process.env.MIKKA_RUNTIME_SOURCE || process.env.GITHUB_SHA,
        workerSha: process.env.SOURCE_SHA, runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT })
      console.log(JSON.stringify({ event: 'runtime_report_verified', sourceCommit: report.sourceCommit, workerSha: report.workerSha, sha256: reference.sha256 }))
    } else if (process.argv[2] !== 'reference') fail('runtime_report_command_invalid')
  })
}
