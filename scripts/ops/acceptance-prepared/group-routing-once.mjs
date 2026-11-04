import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { constants, mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runGroupRoutingBundle, coreComparisonReady } from './group-routing-bundle.mjs'

const REPOSITORY = 'alexj11324/Mikka'
const BRANCH = 'acceptance/proactive-1157-1163'
const WORKFLOW = '.github/workflows/proactive-acceptance.yml'
const ORIGIN = 'https://app.aspectlylabs.com'
const HASH = /^[a-f0-9]{64}$/
const SHA = /^[a-f0-9]{40}$/
const ID = /^[1-9][0-9]{0,15}$/
const digest = value => createHash('sha256').update(value).digest('hex')
class EntryError extends Error { constructor(code) { super('routing_entry_' + code) } }
const check = (ok, code) => { if (!ok) throw new EntryError(code) }
const safeError = error => error instanceof Error && /^(?:routing_entry|routing_bundle)_[a-z0-9_]+$/.test(error.message)
  ? error.message : 'routing_entry_unconfirmed'

function configuration(env) {
  check(env.GITHUB_REPOSITORY === REPOSITORY && env.GITHUB_REF === 'refs/heads/' + BRANCH
    && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_RUN_ATTEMPT === '1'
    && ID.test(env.GITHUB_RUN_ID ?? '') && SHA.test(env.GITHUB_SHA ?? ''), 'workflow_context')
  const fields = ['GROUP_CORE_RUN_ID', 'GROUP_CORE_JOB_ID', 'GROUP_CORE_ARTIFACT_ID', 'GROUP_CORE_WORKFLOW_ID']
  check(fields.every(name => ID.test(env[name] ?? '') && Number.isSafeInteger(Number(env[name]))), 'fixed_core_ids_required')
  check(SHA.test(env.GROUP_CORE_DRIVER_REVISION ?? '') && SHA.test(env.GROUP_ACCEPTANCE_REVISION ?? '')
    && /^dpl_[A-Za-z0-9]+$/.test(env.GROUP_ACCEPTANCE_DEPLOYMENT ?? '')
    && HASH.test(env.GROUP_CORE_ZIP_SHA256 ?? '') && HASH.test(env.GROUP_CORE_REPORT_SHA256 ?? ''), 'fixed_core_digests_required')
  check(env.GROUP_ACCEPTANCE_ORIGIN === ORIGIN && typeof env.GITHUB_WORKSPACE === 'string'
    && env.GITHUB_WORKSPACE.startsWith('/'), 'fixed_target_required')
  return { repository: REPOSITORY, branch: BRANCH, workflow: WORKFLOW,
    coreRunId: Number(env.GROUP_CORE_RUN_ID), coreJobId: Number(env.GROUP_CORE_JOB_ID), artifactId: Number(env.GROUP_CORE_ARTIFACT_ID),
    workflowId: Number(env.GROUP_CORE_WORKFLOW_ID), coreDriverRevision: env.GROUP_CORE_DRIVER_REVISION,
    revision: env.GROUP_ACCEPTANCE_REVISION, deploymentId: env.GROUP_ACCEPTANCE_DEPLOYMENT,
    zipSha256: env.GROUP_CORE_ZIP_SHA256, reportSha256: env.GROUP_CORE_REPORT_SHA256,
    preparedFor: { runId: env.GITHUB_RUN_ID, revision: env.GITHUB_SHA, attempt: 1 } }
}
function verifyRepos(env) {
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  check(source === env.GROUP_ACCEPTANCE_REVISION
    && !execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), 'source_checkout')
  const driverDirectory = dirname(fileURLToPath(import.meta.url))
  check(execFileSync('git', ['-C', driverDirectory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() === env.GITHUB_SHA
    && !execFileSync('git', ['-C', driverDirectory, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim(), 'driver_checkout')
}
function checkCore(json, config) {
  check(Buffer.byteLength(json) <= 2 * 1024 * 1024 && digest(json) === config.reportSha256, 'report_digest')
  let core
  try { core = JSON.parse(json) } catch { throw new EntryError('report_json') }
  check(core?.status === 'pass' && core.group?.status === 'pass' && coreComparisonReady(core)
    && core.expectedDecisionReplays === 24 && core.actualReceiptedDecisionReplays === 24, 'core_not_accepted')
  check(core.origin === ORIGIN && core.revision === config.revision && core.deploymentId === config.deploymentId
    && core.group.revision === config.revision && core.group.deploymentId === config.deploymentId, 'report_source_binding')
  return core
}
async function bytes(response, maximum) {
  const chunks = []; let length = 0
  check(response.body, 'response_body_missing')
  for await (const part of response.body) {
    length += part.length; check(length <= maximum, 'response_too_large'); chunks.push(Buffer.from(part))
  }
  return Buffer.concat(chunks)
}
function reportFromZip(zip) {
  const program = `import io,sys,zipfile,stat
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as archive:
 entries=archive.infolist()
 assert len(entries)==1
 entry=entries[0]
 assert entry.filename=='results.json' and not entry.is_dir() and not (entry.flag_bits & 1)
 assert not stat.S_ISLNK(entry.external_attr >> 16)
 assert entry.compress_type in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED)
 assert 0 < entry.file_size <= 2*1024*1024
 data=archive.read(entry)
 assert len(data)==entry.file_size
 data.decode('utf-8')
 sys.stdout.buffer.write(data)
`
  try { return execFileSync('python3', ['-c', program], { input: zip, maxBuffer: 2 * 1024 * 1024 + 1024, timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'] }).toString('utf8') }
  catch { throw new EntryError('archive_contract') }
}
function writeExclusive(path, text) {
  let fd
  try { fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600) }
  catch (error) { if (error.code === 'EEXIST') throw new EntryError('already_started_or_written'); throw error }
  try { writeFileSync(fd, text) } finally { closeSync(fd) }
}
const inputDirectory = env => resolve(env.GITHUB_WORKSPACE, 'group-routing-input')
const outputFile = env => resolve(env.GITHUB_WORKSPACE, 'group-routing-sanitized/results.json')

/** Read-only GitHub provenance phase; the workflow executes it before receiving
 * any application or provider credential. No redirect receives GH_TOKEN. */
export async function prepareCoreEvidence({ env = process.env, fetchImpl = fetch, verify = verifyRepos } = {}) {
  const config = configuration(env); verify(env)
  check(typeof env.GH_TOKEN === 'string' && env.GH_TOKEN.length > 0, 'github_read_token_required')
  const signal = AbortSignal.timeout(120_000)
  const api = async (path, redirect = 'error') => {
    const response = await fetchImpl('https://api.github.com/repos/' + REPOSITORY + path, { method: 'GET', redirect,
      headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + env.GH_TOKEN, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) })
    if (redirect === 'manual') return response
    check(response.status === 200, 'github_read_failed')
    try { return JSON.parse((await bytes(response, 2 * 1024 * 1024)).toString('utf8')) }
    catch (error) { if (error instanceof EntryError) throw error; throw new EntryError('github_json') }
  }
  const run = await api('/actions/runs/' + config.coreRunId)
  check(run.id === config.coreRunId && run.workflow_id === config.workflowId && run.status === 'completed' && run.conclusion === 'success'
    && run.run_attempt === 1 && run.event === 'push' && run.head_branch === BRANCH && run.head_sha === config.coreDriverRevision
    && run.repository?.full_name === REPOSITORY && run.head_repository?.full_name === REPOSITORY
    && typeof run.path === 'string' && run.path.split('@', 1)[0] === WORKFLOW, 'core_run_binding')
  const jobs = await api('/actions/runs/' + config.coreRunId + '/jobs?filter=all&per_page=100'), job = jobs.jobs?.[0]
  check(jobs.total_count === 1 && Array.isArray(jobs.jobs) && jobs.jobs.length === 1 && job.id === config.coreJobId
    && job.run_id === config.coreRunId && job.head_sha === config.coreDriverRevision && job.name === 'acceptance'
    && job.status === 'completed' && job.conclusion === 'success', 'core_job_binding')
  const artifact = await api('/actions/artifacts/' + config.artifactId)
  check(artifact.id === config.artifactId && artifact.name === 'proactive-acceptance-' + config.coreRunId && artifact.expired === false
    && Number.isSafeInteger(artifact.size_in_bytes) && artifact.size_in_bytes > 0 && artifact.size_in_bytes <= 8 * 1024 * 1024
    && artifact.workflow_run?.id === config.coreRunId && artifact.workflow_run.head_sha === config.coreDriverRevision
    && artifact.workflow_run.head_branch === BRANCH
    && (!artifact.digest || artifact.digest === 'sha256:' + config.zipSha256), 'core_artifact_binding')
  const redirect = await api('/actions/artifacts/' + config.artifactId + '/zip', 'manual')
  check(redirect.status === 302, 'archive_redirect')
  let location
  try { location = new URL(redirect.headers.get('location')) } catch { throw new EntryError('archive_location') }
  check(location.protocol === 'https:' && !location.username && !location.password && !location.hash && !location.port
    && (location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.actions.githubusercontent.com')), 'archive_location')
  const downloaded = await fetchImpl(location, { method: 'GET', redirect: 'error',
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  check(downloaded.status === 200, 'archive_download')
  const zip = await bytes(downloaded, 8 * 1024 * 1024)
  check(digest(zip) === config.zipSha256, 'archive_digest')
  const json = reportFromZip(zip); checkCore(json, config)
  const manifest = { schemaVersion: 1, ...config, gitHubMetadataVerified: true, uniqueJobVerified: true,
    archiveDigestVerified: true, reportDigestVerified: true, artifactDigestPresent: Boolean(artifact.digest) }
  const directory = inputDirectory(env)
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if (error.code === 'EEXIST') throw new EntryError('already_prepared'); throw error }
  writeExclusive(resolve(directory, 'core-report.json'), json)
  writeExclusive(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return manifest
}

export async function runPreparedRouting({ env = process.env, bundle = runGroupRoutingBundle, verify = verifyRepos } = {}) {
  const config = configuration(env); verify(env)
  const directory = inputDirectory(env), manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
  check(manifest.schemaVersion === 1 && Object.keys(config).every(key => JSON.stringify(manifest[key]) === JSON.stringify(config[key]))
    && ['gitHubMetadataVerified', 'uniqueJobVerified', 'archiveDigestVerified', 'reportDigestVerified'].every(key => manifest[key] === true), 'prepared_manifest_binding')
  const json = readFileSync(resolve(directory, 'core-report.json'), 'utf8'); checkCore(json, config)
  writeExclusive(resolve(directory, 'execution-start.json'), JSON.stringify({ ...config.preparedFor, at: new Date().toISOString() }) + '\n')
  const report = await bundle({ env, coreReportJson: json, coreReportSha256: config.reportSha256 })
  return { ...report, coreArtifactProof: manifest }
}

export function writeRoutingReport(report, env = process.env) {
  const text = JSON.stringify(report, null, 2) + '\n'
  for (const name of ['GH_TOKEN', 'SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD', 'DEEPSEEK_API_KEY', 'E2B_API_KEY'])
    check(!env[name] || env[name].length < 8 || !text.includes(env[name]), 'report_secret')
  check(!/"(?:cookie|authorization|password|apiKey|prompt|body|email)"\s*:/i.test(text), 'report_private_field')
  mkdirSync(dirname(outputFile(env)), { recursive: true, mode: 0o700 })
  writeExclusive(outputFile(env), text)
}
async function main() {
  const mode = process.argv[2]; let report
  try {
    check(process.argv.length === 3 && ['prepare', 'run'].includes(mode), 'mode_required')
    if (mode === 'prepare') {
      const evidence = await prepareCoreEvidence()
      console.log(JSON.stringify({ status: 'prepared', coreRunId: evidence.coreRunId, coreJobId: evidence.coreJobId,
        artifactId: evidence.artifactId, reportSha256: evidence.reportSha256 }))
      return
    }
    report = await runPreparedRouting()
  } catch (error) { report = { schemaVersion: 1, status: 'failed', scope: 'single-run-group-routing-entry', error: safeError(error) } }
  report.entryDigest = digest(readFileSync(fileURLToPath(import.meta.url)))
  writeRoutingReport(report)
  console.log(JSON.stringify({ status: report.status, error: report.error ?? null,
    coreRunId: report.coreArtifactProof?.coreRunId ?? null, messageAttempts: report.group?.messageAttempts ?? null }))
  if (report.status !== 'passed') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  await main().catch(() => { console.log(JSON.stringify({ status: 'failed', error: 'routing_entry_report_unconfirmed' })); process.exitCode = 1 })
