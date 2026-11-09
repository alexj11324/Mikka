/** Fixed #1782 publication-fixture GitHub child. No production dependency loads here. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { check, safeCode, validateState } from './github-write-helper.mjs'

export const REPO = 'alexj11324/Mikka'
export const BRANCH = 'ops/self-hosted-vault-closeout-20261108'
export const WORKFLOW = '.github/workflows/issue1782-github-write.yml'
export const APP_ORIGIN = 'https://app.aspectlylabs.com'
const API = 'https://api.github.com/repos/' + REPO
const SHA = /^[a-f0-9]{40}$/, DIGEST = /^[a-f0-9]{64}$/
const positive = value => Number.isSafeInteger(value) && value > 0
const iso = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
const hash = value => createHash('sha256').update(value).digest('hex')
const exact = (row, keys) => row && typeof row === 'object' && !Array.isArray(row)
  && isDeepStrictEqual(Object.keys(row).sort(), [...keys].sort())
export const OWN_PATHS = Object.freeze([WORKFLOW, ...['provider', 'helper', 'store', 'guard', 'runner'].map(name =>
  'scripts/ops/issue1782/github-write-' + name + '.mjs'), 'scripts/ops/issue1782/github-write.test.mjs',
  'scripts/ops/issue1782/github-write-guard.test.mjs'])
const RECOVERY_KEYS = ['prepareApplicationSha', 'prepareApplicationTree', 'prepareOpsSha', 'prepareRunId',
  'prepareArtifactId', 'prepareArchiveSha256', 'prepareArchiveBytes', 'prepareReceiptSha256', 'prepareReceiptBytes']

// Every activation binding remains unfilled. A later reviewed ordinary append
// must bind the real source/window; cleanup binds this batch's actual artifact.
export const BINDING = Object.freeze({ applicationSha: null, applicationTree: null, opsParentSha: null, opsParentTree: null,
  appendPaths: null, operation: null, windowCommentId: null, windowBodySha256: null, windowStartsAt: null, windowExpiresAt: null,
  prepareApplicationSha: null, prepareApplicationTree: null, prepareOpsSha: null, prepareRunId: null, prepareArtifactId: null,
  prepareArchiveSha256: null, prepareArchiveBytes: null, prepareReceiptSha256: null, prepareReceiptBytes: null })

export function checkBinding(binding = BINDING) {
  check(exact(binding, Object.keys(BINDING)) && ['applicationSha', 'applicationTree', 'opsParentSha', 'opsParentTree'].every(key => SHA.test(binding[key] ?? ''))
    && ['prepare', 'cleanup'].includes(binding.operation) && Array.isArray(binding.appendPaths) && binding.appendPaths.length > 0
    && binding.appendPaths.every(path => OWN_PATHS.includes(path)) && new Set(binding.appendPaths).size === binding.appendPaths.length
    && positive(binding.windowCommentId) && DIGEST.test(binding.windowBodySha256 ?? '')
    && iso(binding.windowStartsAt) && iso(binding.windowExpiresAt)
    && Date.parse(binding.windowExpiresAt) > Date.parse(binding.windowStartsAt)
    && Date.parse(binding.windowExpiresAt) - Date.parse(binding.windowStartsAt) <= 20 * 60000, 'binding_refused')
  if (binding.operation === 'prepare') check(RECOVERY_KEYS.every(key => binding[key] === null), 'binding_refused')
  else check(['prepareApplicationSha', 'prepareApplicationTree', 'prepareOpsSha'].every(key => SHA.test(binding[key] ?? ''))
    && ['prepareRunId', 'prepareArtifactId', 'prepareArchiveBytes', 'prepareReceiptBytes'].every(key => positive(binding[key]))
    && binding.prepareArchiveBytes <= 262144 && binding.prepareReceiptBytes <= 65536
    && ['prepareArchiveSha256', 'prepareReceiptSha256'].every(key => DIGEST.test(binding[key] ?? '')), 'binding_refused')
  return binding
}

export function guardContext(env, event, source, binding = BINDING) {
  checkBinding(binding)
  check(env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.GITHUB_REPOSITORY === REPO
    && env.GITHUB_ACTOR === 'alexj11324' && env.GITHUB_TRIGGERING_ACTOR === 'alexj11324'
    && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/' + BRANCH
    && env.GITHUB_WORKFLOW_REF === REPO + '/' + WORKFLOW + '@refs/heads/' + BRANCH
    && env.GITHUB_RUN_ATTEMPT === '1' && /^[1-9]\d{0,19}$/.test(env.GITHUB_RUN_ID ?? '')
    && env.GITHUB_JOB === 'github_child' && SHA.test(env.GITHUB_SHA ?? '')
    && event.repository?.id === 1427517699 && event.repository?.owner?.id === 183887963
    && event.ref === env.GITHUB_REF && event.before === binding.opsParentSha && event.after === env.GITHUB_SHA
    && event.forced === false && event.deleted === false && source.opsSha === env.GITHUB_SHA
    && source.opsParentTree === binding.opsParentTree && isDeepStrictEqual(source.parents, [binding.opsParentSha])
    && isDeepStrictEqual([...source.changedPaths].sort(), [...binding.appendPaths].sort())
    && source.applicationSha === binding.applicationSha && source.applicationTree === binding.applicationTree
    && source.clean === true && source.ownFilesRegular === true && source.workflowApplicationPin === binding.applicationSha, 'source_refused')
}

export async function guardSource(env, binding = BINDING) {
  checkBinding(binding)
  check(typeof env.GITHUB_WORKSPACE === 'string' && typeof env.GITHUB_EVENT_PATH === 'string', 'source_refused')
  const ops = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), application = resolve(env.GITHUB_WORKSPACE, 'application')
  check(ops === resolve(env.GITHUB_WORKSPACE, 'ops') && !(await lstat(ops)).isSymbolicLink()
    && !(await lstat(application)).isSymbolicLink(), 'source_refused')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }).trim()
  const eventBytes = await readFile(env.GITHUB_EVENT_PATH)
  check(eventBytes.length <= 1024 * 1024, 'source_refused')
  const event = JSON.parse(eventBytes)
  let regular = true
  for (const path of OWN_PATHS) {
    const stat = await lstat(resolve(ops, path))
    regular &&= stat.isFile() && !stat.isSymbolicLink() && git(ops, 'ls-tree', 'HEAD', '--', path).startsWith('100644 blob ')
  }
  const workflow = await readFile(resolve(ops, WORKFLOW), 'utf8')
  const pins = [...workflow.matchAll(/^          ref: ([a-f0-9]{40})$/gm)].map(match => match[1])
  guardContext(env, event, {
    opsSha: git(ops, 'rev-parse', 'HEAD'), opsParentTree: git(ops, 'rev-parse', binding.opsParentSha + '^{tree}'),
    parents: git(ops, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').slice(1),
    changedPaths: git(ops, 'diff', '--name-only', '--no-renames', binding.opsParentSha, 'HEAD').split('\n').filter(Boolean),
    applicationSha: git(application, 'rev-parse', 'HEAD'), applicationTree: git(application, 'rev-parse', 'HEAD^{tree}'),
    clean: !git(ops, 'status', '--porcelain=v1', '--untracked-files=no') && !git(application, 'status', '--porcelain=v1', '--untracked-files=no'),
    ownFilesRegular: regular, workflowApplicationPin: pins.length === 1 ? pins[0] : null,
  }, binding)
  return { ops, application }
}

const budgetError = () => Object.assign(new Error('issue1782_github_budget_exhausted'), { code: 'budget_exhausted' })
function abortable(signal, work, late = () => {}) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => { if (settled) return false; settled = true; signal.removeEventListener('abort', abort); callback(value); return true }
    const abort = () => finish(reject, signal.reason ?? budgetError())
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve().then(() => { signal.throwIfAborted(); return work() }).then(value => {
      if (!finish(resolve, value)) Promise.resolve().then(() => late(value)).catch(() => {})
    }, error => finish(reject, error))
  })
}
export async function httpBytes(fetchImpl, url, init, { limit = 1024 * 1024, expected = 200, signal, timeoutMs = 15000 } = {}) {
  const controller = new AbortController(), abort = () => controller.abort(signal.reason ?? budgetError())
  signal?.throwIfAborted(); signal?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(budgetError()), timeoutMs)
  let reader
  try {
    const response = await abortable(controller.signal, () => fetchImpl(url, { ...init, redirect: 'manual', signal: controller.signal }), value => value.body?.cancel())
    if (response.status !== expected) { response.body?.cancel().catch(() => {}); check(false, 'http_failed') }
    if (expected === 302) { response.body?.cancel().catch(() => {}); return { location: response.headers.get('location') } }
    check(response.body, 'http_failed'); reader = response.body.getReader()
    const chunks = []; let bytes = 0
    for (;;) {
      const item = await abortable(controller.signal, () => reader.read()); if (item.done) break
      bytes += item.value.length; check(bytes <= limit, 'response_invalid'); chunks.push(item.value)
    }
    return Buffer.concat(chunks)
  } finally { reader?.cancel().catch(() => {}); reader?.releaseLock(); clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}
const parse = bytes => { try { return JSON.parse(bytes) } catch (error) { throw new Error('issue1782_github_response_invalid', { cause: error }) } }
export function windowRecord(binding) {
  return { state: 'active', batch: 1782, mode: 'github_write_child_' + binding.operation,
    mainSha: binding.applicationSha, opsParentSha: binding.opsParentSha, repository: 'alexj11324/Mikka-handoff',
    startsAt: binding.windowStartsAt, expiresAt: binding.windowExpiresAt }
}
export async function guardMain(env, binding = BINDING, fetchImpl = fetch, now = Date.now, minimumRemainingMs = 0, signal) {
  checkBinding(binding)
  const time = () => { signal?.throwIfAborted(); const at = now()
    check(at >= Date.parse(binding.windowStartsAt) && at + minimumRemainingMs < Date.parse(binding.windowExpiresAt), 'window_expired'); return at }
  time(); check(typeof env.GITHUB_TOKEN === 'string' && env.GITHUB_TOKEN.length > 0, 'source_refused')
  const headers = { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'cache-control': 'no-store', 'x-github-api-version': '2026-03-10' }
  const github = async path => { const data = parse(await httpBytes(fetchImpl, API + path, { headers }, { signal })); time(); return data }
  const run = await github('/actions/runs/' + env.GITHUB_RUN_ID)
  check(run.id === Number(env.GITHUB_RUN_ID) && run.run_attempt === 1 && run.head_sha === env.GITHUB_SHA
    && run.event === 'push' && run.path === WORKFLOW && run.head_branch === BRANCH
    && run.actor?.login === 'alexj11324' && run.triggering_actor?.login === 'alexj11324'
    && run.repository?.id === 1427517699 && run.repository.full_name === REPO
    && run.head_repository?.id === 1427517699 && run.head_repository.full_name === REPO, 'source_refused')
  const main = await github('/git/ref/heads/main')
  check(main.ref === 'refs/heads/main' && main.object?.type === 'commit' && main.object.sha === binding.applicationSha, 'main_changed')
  const version = parse(await httpBytes(fetchImpl, APP_ORIGIN + '/mikka/api/version?verify=1782-github-child-' + time(),
    { headers: { 'cache-control': 'no-store' } }, { limit: 8192, signal }))
  time(); check(version.build === binding.applicationSha, 'build_changed')
  const issue = await github('/issues/1752'); check(issue.number === 1752 && positive(issue.comments), 'window_changed')
  const comments = await github('/issues/1752/comments?per_page=1&page=' + issue.comments), comment = comments?.[0]
  check(Array.isArray(comments) && comments.length === 1 && comment.id === binding.windowCommentId
    && comment.issue_url === API + '/issues/1752' && comment.user?.login === 'alexj11324' && comment.user.id === 183887963
    && typeof comment.body === 'string' && hash(comment.body) === binding.windowBodySha256, 'window_changed')
  const marker = '<!-- mikka-1782-github-write-child:v1\n', start = comment.body.indexOf(marker), end = comment.body.indexOf('\n-->', start)
  check(start >= 0 && end > start && comment.body.indexOf(marker, start + marker.length) === -1, 'window_changed')
  const record = parse(comment.body.slice(start + marker.length, end))
  check(isDeepStrictEqual(record, windowRecord(binding)), 'window_changed')
  for (const status of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const runs = await github('/actions/workflows/e2b-official-runtime.yml/runs?branch=main&status=' + status + '&per_page=1')
    check(Number.isSafeInteger(runs.total_count) && runs.total_count >= 0 && Array.isArray(runs.workflow_runs), 'response_invalid')
    check(runs.total_count === 0 && runs.workflow_runs.length === 0, 'runtime_active')
  }
  return { applicationSha: binding.applicationSha, servedBuild: version.build, checkedAt: new Date(time()).toISOString(),
    windowCommentId: binding.windowCommentId, officialRuntimeIdle: true }
}

export function extractReceipt(archive, binding) {
  check(Buffer.isBuffer(archive) && archive.length === binding.prepareArchiveBytes && hash(archive) === binding.prepareArchiveSha256, 'cleanup_evidence_invalid')
  const python = 'import io,sys,zipfile,stat,hashlib\nraw=sys.stdin.buffer.read()\nwith zipfile.ZipFile(io.BytesIO(raw)) as z:\n e=z.infolist()\n assert len(e)==1\n x=e[0]\n assert x.filename==x.orig_filename=="receipt.json" and not x.is_dir() and not x.external_attr&0x10 and not x.flag_bits&1\n assert stat.S_IFMT(x.external_attr>>16) in (0,stat.S_IFREG)\n assert x.file_size==int(sys.argv[1])\n with z.open(x) as f: data=f.read(int(sys.argv[1])+1)\n assert len(data)==int(sys.argv[1]) and hashlib.sha256(data).hexdigest()==sys.argv[2]\n sys.stdout.buffer.write(data)\n'
  let bytes
  try { bytes = execFileSync('python3', ['-c', python, String(binding.prepareReceiptBytes), binding.prepareReceiptSha256],
    { input: archive, timeout: 10000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] }) }
  catch (error) { throw new Error('issue1782_github_cleanup_evidence_invalid', { cause: error }) }
  const receipt = parse(bytes)
  check(receipt.version === 1 && receipt.issue === 1782 && receipt.operation === 'prepare'
    && ['passed', 'incomplete'].includes(receipt.status)
    && isDeepStrictEqual(receipt.source, { applicationSha: binding.prepareApplicationSha, applicationTree: binding.prepareApplicationTree,
      opsSource: binding.prepareOpsSha, runId: String(binding.prepareRunId), runAttempt: '1' }), 'cleanup_evidence_invalid')
  return { state: validateState(receipt.state), receiptSha256: hash(bytes), source: receipt.source }
}
export async function cleanupEvidence(env, binding, fetchImpl = fetch, signal) {
  checkBinding(binding); check(binding.operation === 'cleanup', 'binding_refused')
  const headers = { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'x-github-api-version': '2026-03-10' }
  const json = async path => parse(await httpBytes(fetchImpl, API + path, { headers }, { signal }))
  const run = await json('/actions/runs/' + binding.prepareRunId)
  check(run.id === binding.prepareRunId && run.run_attempt === 1 && run.head_sha === binding.prepareOpsSha
    && run.status === 'completed' && ['success', 'failure'].includes(run.conclusion)
    && run.event === 'push' && run.path === WORKFLOW && run.head_branch === BRANCH
    && run.actor?.login === 'alexj11324' && run.triggering_actor?.login === 'alexj11324'
    && run.repository?.id === 1427517699 && run.repository.full_name === REPO
    && run.head_repository?.id === 1427517699 && run.head_repository.full_name === REPO, 'cleanup_evidence_invalid')
  const artifact = await json('/actions/artifacts/' + binding.prepareArtifactId)
  check(artifact.id === binding.prepareArtifactId && artifact.expired === false
    && artifact.name === 'issue1782-github-write-prepare-' + binding.prepareRunId + '-1'
    && artifact.workflow_run?.id === binding.prepareRunId && artifact.workflow_run.head_sha === binding.prepareOpsSha
    && artifact.workflow_run.head_branch === BRANCH && artifact.workflow_run.repository_id === 1427517699 && artifact.workflow_run.head_repository_id === 1427517699
    && artifact.size_in_bytes === binding.prepareArchiveBytes && artifact.digest === 'sha256:' + binding.prepareArchiveSha256, 'cleanup_evidence_invalid')
  const redirect = await httpBytes(fetchImpl, API + '/actions/artifacts/' + binding.prepareArtifactId + '/zip', { headers }, { expected: 302, signal })
  const url = new URL(redirect.location)
  check(typeof redirect.location === 'string' && ![...redirect.location].some(char => char === '\\' || char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)
    && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443') && !url.hash && url.search
    && (/^[a-z0-9][a-z0-9-]*\.blob\.core\.windows\.net$/.test(url.hostname) || url.hostname === 'results-receiver.actions.githubusercontent.com'), 'cleanup_evidence_invalid')
  const archive = await httpBytes(fetchImpl, url.href, {}, { limit: binding.prepareArchiveBytes, signal })
  return extractReceipt(archive, binding)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    check(process.argv.length === 3 && process.argv[2] === '--' + BINDING.operation, 'arguments_invalid')
    await guardSource(process.env)
    const signal = AbortSignal.timeout(120000)
    await guardMain(process.env, BINDING, fetch, Date.now, 8 * 60000, signal)
    if (BINDING.operation === 'cleanup') await cleanupEvidence(process.env, BINDING, fetch, signal)
    const guard = await guardMain(process.env, BINDING, fetch, Date.now, 8 * 60000, signal)
    console.log(JSON.stringify({ version: 1, issue: 1782, status: 'guard_passed', operation: BINDING.operation, ...guard }))
  } catch (error) { console.log(JSON.stringify({ version: 1, issue: 1782, status: 'refused', code: safeCode(error) })); process.exitCode = 1 }
}
