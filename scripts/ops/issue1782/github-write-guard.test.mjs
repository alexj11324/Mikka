import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BINDING, BRANCH, REPO, WORKFLOW, OWN_PATHS, checkBinding, guardContext, guardSource,
  guardMain, windowRecord, httpBytes, extractReceipt, cleanupEvidence } from './github-write-guard.mjs'
import { digest, stateFor } from './github-write-helper.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const NOW = Date.parse('2026-11-09T00:02:00.000Z')
const S = '1'.repeat(40), T = '2'.repeat(40), P = '3'.repeat(40), PT = '4'.repeat(40), H = '5'.repeat(40)
function binding(change = {}) {
  const value = { ...Object.fromEntries(Object.keys(BINDING).map(key => [key, null])), applicationSha: S, applicationTree: T, opsParentSha: P, opsParentTree: PT,
    appendPaths: [...OWN_PATHS], operation: 'prepare', windowCommentId: 12, windowBodySha256: 'a'.repeat(64),
    windowStartsAt: '2026-11-09T00:00:00.000Z', windowExpiresAt: '2026-11-09T00:20:00.000Z', ...change }
  return value
}
const env = () => ({ CI: 'true', GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPO, GITHUB_SHA: H,
  GITHUB_REF: 'refs/heads/' + BRANCH, GITHUB_EVENT_NAME: 'push', GITHUB_RUN_ID: '21', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324', GITHUB_JOB: 'github_child',
  GITHUB_WORKFLOW_REF: REPO + '/' + WORKFLOW + '@refs/heads/' + BRANCH, GITHUB_TOKEN: 'synthetic-github-token' })
const event = () => ({ repository: { id: 1427517699, owner: { id: 183887963 } }, ref: 'refs/heads/' + BRANCH,
  before: P, after: H, forced: false, deleted: false })
const source = () => ({ opsSha: H, opsParentTree: PT, parents: [P], changedPaths: [...OWN_PATHS], applicationSha: S,
  applicationTree: T, clean: true, ownFilesRegular: true, workflowApplicationPin: S })
const repo = () => ({ id: 1427517699, full_name: REPO })
const runRecord = () => ({ id: 21, run_attempt: 1, head_sha: H, event: 'push', path: WORKFLOW, head_branch: BRANCH,
  actor: { login: 'alexj11324' }, triggering_actor: { login: 'alexj11324' }, repository: repo(), head_repository: repo() })
function httpFixture(change = () => {}, selected = binding()) {
  const b = structuredClone(selected), calls = [], body = 'Own bounded test window\n<!-- mikka-1782-github-write-child:v1\n' + JSON.stringify(windowRecord(b)) + '\n-->'
  b.windowBodySha256 = hash(body)
  const data = { run: runRecord(), main: { ref: 'refs/heads/main', object: { type: 'commit', sha: S } },
    version: { build: S }, issue: { number: 1752, comments: 7 }, comments: [{ id: 12,
      issue_url: 'https://api.github.com/repos/' + REPO + '/issues/1752', user: { id: 183887963, login: 'alexj11324' }, body }],
    active: { total_count: 0, workflow_runs: [] } }
  change(data, b)
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); const path = new URL(url).pathname
    assert.equal(init.redirect, 'manual')
    if (path === '/mikka/api/version') { assert.equal(init.headers.authorization, undefined); return Response.json(data.version) }
    assert.equal(init.headers.authorization, 'Bearer synthetic-github-token')
    assert.equal(init.headers['x-github-api-version'], '2026-03-10')
    if (path.endsWith('/actions/runs/21')) return Response.json(data.run)
    if (path.endsWith('/git/ref/heads/main')) return Response.json(data.main)
    if (path.endsWith('/issues/1752')) return Response.json(data.issue)
    if (path.endsWith('/issues/1752/comments')) {
      assert.equal(new URL(url).search, '?per_page=1&page=7'); return Response.json(data.comments)
    }
    if (path.endsWith('/actions/workflows/e2b-official-runtime.yml/runs')) return Response.json(data.active)
    assert.fail('unexpected test HTTP path')
  }
  return { b, data, calls, fetchImpl }
}

test('unbound draft refuses before source IO and does not load application dependencies', async () => {
  if (Object.values(BINDING).every(value => value === null)) {
    assert.throws(() => checkBinding(), /binding_refused/)
    await assert.rejects(guardSource({}), /binding_refused/)
  } else assert.doesNotThrow(() => checkBinding())
})
test('activation accepts only the fixed bounded prepare and exact-purpose cleanup state', () => {
  assert.equal(checkBinding(binding()).operation, 'prepare')
  for (const mutation of [
    b => { b.applicationSha = 'main' }, b => { b.windowExpiresAt = '2026-11-09T00:20:00.001Z' },
    b => { b.windowStartsAt = b.windowExpiresAt }, b => { b.windowCommentId = '12' },
    b => { b.appendPaths.push('lib/github/connection.ts') }, b => { b.appendPaths.push(OWN_PATHS[0]) },
    b => { b.extra = true }, b => { b.prepareRunId = 21 }, b => { b.operation = 'arbitrary' },
  ]) { const b = binding(); mutation(b); assert.throws(() => checkBinding(b), /binding_refused/) }
})
test('source checks reject impersonated, rerun, force-pushed, extra-path or different product executions', () => {
  guardContext(env(), event(), source(), binding())
  for (const [kind, field, value] of [
    ['env', 'GITHUB_ACTOR', 'foreign'], ['env', 'GITHUB_TRIGGERING_ACTOR', 'foreign'], ['env', 'GITHUB_RUN_ATTEMPT', '2'],
    ['env', 'GITHUB_EVENT_NAME', 'workflow_dispatch'], ['env', 'GITHUB_REF', 'refs/heads/main'], ['env', 'GITHUB_JOB', 'other'],
    ['event', 'forced', true], ['event', 'deleted', true], ['event', 'before', H],
    ['source', 'parents', [P, H]], ['source', 'opsParentTree', T], ['source', 'changedPaths', [...OWN_PATHS, 'other']],
    ['source', 'applicationSha', H], ['source', 'applicationTree', PT], ['source', 'clean', false],
    ['source', 'ownFilesRegular', false], ['source', 'workflowApplicationPin', H],
  ]) {
    const records = { env: env(), event: event(), source: source() }; records[kind][field] = value
    assert.throws(() => guardContext(records.env, records.event, records.source, binding()), /source_refused/)
  }
})
test('actual temporary Git trees bind sole parent, exact files and application pin; tracked edits refuse', async () => {
  const workspace = await mkdtemp(resolve(tmpdir(), 'mikka-1782-github-source-'))
  const original = resolve(dirname(fileURLToPath(import.meta.url)), '../../..'), ops = resolve(workspace, 'ops'), app = resolve(workspace, 'application')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  try {
    for (const cwd of [ops, app]) {
      await mkdir(cwd); git(cwd, 'init', '-q'); git(cwd, 'config', 'user.name', 'Synthetic fixture'); git(cwd, 'config', 'user.email', 'fixture@example.test')
      await writeFile(resolve(cwd, 'base.txt'), 'Synthetic local test\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-qm', 'Synthetic baseline')
    }
    const parent = git(ops, 'rev-parse', 'HEAD'), parentTree = git(ops, 'rev-parse', 'HEAD^{tree}')
    const appSha = git(app, 'rev-parse', 'HEAD'), appTree = git(app, 'rev-parse', 'HEAD^{tree}')
    for (const path of OWN_PATHS) { await mkdir(dirname(resolve(ops, path)), { recursive: true }); await cp(resolve(original, path), resolve(ops, path)) }
    const workflow = resolve(ops, WORKFLOW)
    const originalWorkflow = await readFile(workflow, 'utf8')
    await writeFile(workflow, originalWorkflow.replace(/^          ref: (?:UNBOUND|[a-f0-9]{40})$/m, '          ref: ' + appSha))
    git(ops, 'add', '.'); git(ops, 'commit', '-qm', 'Synthetic exact own append')
    const head = git(ops, 'rev-parse', 'HEAD'), eventPath = resolve(workspace, 'event.json')
    await writeFile(eventPath, JSON.stringify({ ...event(), before: parent, after: head }))
    const b = binding({ applicationSha: appSha, applicationTree: appTree, opsParentSha: parent, opsParentTree: parentTree })
    const e = { ...env(), GITHUB_SHA: head, GITHUB_WORKSPACE: workspace, GITHUB_EVENT_PATH: eventPath }
    const loaded = await import(pathToFileURL(resolve(ops, 'scripts/ops/issue1782/github-write-guard.mjs')).href)
    assert.deepEqual(await loaded.guardSource(e, b), { ops, application: app })
    await writeFile(resolve(app, 'base.txt'), 'changed\n')
    await assert.rejects(loaded.guardSource(e, b), /source_refused/)
  } finally { await rm(workspace, { recursive: true, force: true }) }
})
test('actual current source, served build and latest bounded own comment permit only idle official runtime', async () => {
  const f = httpFixture(), result = await guardMain(env(), f.b, f.fetchImpl, () => NOW, 8 * 60000)
  assert.equal(result.officialRuntimeIdle, true); assert.equal(result.servedBuild, S)
  assert.equal(f.calls.filter(call => call.url.includes('/e2b-official-runtime.yml/runs?')).length, 5)
})
for (const [name, mutate, code] of [
  ['moved main', d => { d.main.object.sha = H }, 'main_changed'],
  ['stale public build', d => { d.version.build = H }, 'build_changed'],
  ['rerun', d => { d.run.run_attempt = 2 }, 'source_refused'],
  ['foreign source repo', d => { d.run.head_repository.id++ }, 'source_refused'],
  ['another latest comment', d => { d.comments[0].id++ }, 'window_changed'],
  ['edited comment', d => { d.comments[0].body += ' changed' }, 'window_changed'],
  ['other author', d => { d.comments[0].user.id++ }, 'window_changed'],
  ['runtime still active', d => { d.active = { total_count: 1, workflow_runs: [{}] } }, 'runtime_active'],
  ['malformed count', d => { d.active.total_count = false }, 'response_invalid'],
]) test('precredential guard rejects ' + name, async () => {
  const f = httpFixture(mutate); await assert.rejects(guardMain(env(), f.b, f.fetchImpl, () => NOW), new RegExp(code))
})
test('comment with updated hash must still bind exact fixed repository and operation', async () => {
  const f = httpFixture((d, b) => {
    d.comments[0].body = d.comments[0].body.replace('Mikka-handoff', 'foreign-repository')
    b.windowBodySha256 = hash(d.comments[0].body)
  })
  await assert.rejects(guardMain(env(), f.b, f.fetchImpl, () => NOW), /window_changed/)
})
test('a window crossed during reads refuses and no second budget is created', async () => {
  const f = httpFixture(); let clock = NOW
  const fetchImpl = async (...args) => { const result = await f.fetchImpl(...args); clock += 5 * 60000; return result }
  await assert.rejects(guardMain(env(), f.b, fetchImpl, () => clock, 8 * 60000), /window_expired/)
  assert.equal(f.calls.length, 2)
})
test('HTTP byte cap rejects overlong and stalled response bodies; redirects do not forward authentication', async () => {
  await assert.rejects(httpBytes(async () => new Response('12345'), 'https://synthetic.test', {}, { limit: 4 }), /response_invalid/)
  let cancelled = false
  await assert.rejects(httpBytes(async () => new Response(new ReadableStream({ cancel() { cancelled = true } })),
    'https://synthetic.test', {}, { timeoutMs: 20 }), /budget_exhausted/)
  assert.equal(cancelled, true)
  await assert.rejects(httpBytes(async () => new Response(null, { status: 302, headers: { location: 'https://other.test' } }),
    'https://synthetic.test', {}), /http_failed/)
})
test('HTTP wall budget rejects even a fetch implementation that ignores its abort signal', async () => {
  await assert.rejects(httpBytes(() => new Promise(() => {}), 'https://synthetic.test', {}, { timeoutMs: 20 }), /budget_exhausted/)
})

function receipt() {
  const prepared = { providerExpiry: NOW + 4 * 3600000, tokenSha256: digest('synthetic-only-child'),
    metadata: { appId: '123', appClientId: 'Iv1.fixture', repositoryId: '456', installationId: '789' } }
  return { version: 1, issue: 1782, operation: 'prepare', status: 'passed', source: { applicationSha: S, applicationTree: T,
    opsSource: H, runId: '21', runAttempt: '1' }, state: stateFor(prepared, { expiresAt: new Date(NOW + 3 * 3600000).toISOString(), updatedAt: new Date(NOW).toISOString() }) }
}
function archiveFor(value, mode = 'normal') {
  const bytes = Buffer.from(JSON.stringify(value))
  const script = 'import sys,io,zipfile,stat\nb=sys.stdin.buffer.read();o=io.BytesIO()\nwith zipfile.ZipFile(o,"w",zipfile.ZIP_DEFLATED) as z:\n x=zipfile.ZipInfo("../receipt.json" if sys.argv[1]=="path" else "receipt.json")\n x.external_attr=((stat.S_IFLNK if sys.argv[1]=="link" else stat.S_IFREG)|0o600)<<16\n if sys.argv[1]=="dosdir":x.external_attr|=0x10\n z.writestr(x,b)\n if sys.argv[1]=="extra":z.writestr("extra.json",b)\n if sys.argv[1]=="duplicate":z.writestr("receipt.json",b)\nsys.stdout.buffer.write(o.getvalue())\n'
  return { bytes, archive: execFileSync('python3', ['-c', script, mode], { input: bytes, stdio: ['pipe', 'pipe', 'pipe'] }) }
}
function recovery(value = receipt(), mode = 'normal') {
  const { bytes, archive } = archiveFor(value, mode)
  return { archive, b: binding({ operation: 'cleanup', prepareApplicationSha: S, prepareApplicationTree: T,
    prepareOpsSha: H, prepareRunId: 21, prepareArtifactId: 22, prepareArchiveSha256: hash(archive), prepareArchiveBytes: archive.length,
    prepareReceiptSha256: hash(bytes), prepareReceiptBytes: bytes.length }) }
}
test('actual ZIP and member verification accepts exact own nonsecret state without token bytes', () => {
  const f = recovery(), parsed = extractReceipt(f.archive, f.b)
  assert.deepEqual(parsed.state, receipt().state); assert.equal(parsed.receiptSha256, f.b.prepareReceiptSha256)
  assert.doesNotMatch(JSON.stringify(parsed), /synthetic-only-child/)
})
for (const mode of ['path', 'link', 'dosdir', 'extra', 'duplicate']) test('cleanup ZIP rejects ' + mode + ' archive even with rebound digest', () => {
  const f = recovery(receipt(), mode); assert.throws(() => extractReceipt(f.archive, f.b), /cleanup_evidence_invalid/)
})
test('cleanup rejects altered CRC, SHA, source, child purpose and expanded permissions', () => {
  const f = recovery(), bad = Buffer.from(f.archive); bad[50] ^= 1
  assert.throws(() => extractReceipt(bad, { ...f.b, prepareArchiveSha256: hash(bad) }), /cleanup_evidence_invalid/)
  assert.throws(() => extractReceipt(f.archive, { ...f.b, prepareReceiptSha256: 'e'.repeat(64) }), /cleanup_evidence_invalid/)
  for (const change of [r => { r.source.opsSource = P }, r => { r.state.purpose = 'other' },
    r => { r.state.issue = 1505 }, r => { r.state.permissions.checks = 'write' }, r => { r.state.token = 'synthetic-hidden' }]) {
    const r = receipt(); change(r); const g = recovery(r)
    assert.throws(() => extractReceipt(g.archive, g.b), /cleanup_evidence_invalid|invalid_state/)
  }
})
test('exact original run and artifact bind recovery; signed download never receives GitHub authorization', async () => {
  const f = recovery(), calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init }); const path = new URL(url).pathname
    if (new URL(url).hostname === 'synthetic.blob.core.windows.net') {
      assert.equal(init.headers, undefined); assert.equal(init.redirect, 'manual'); return new Response(f.archive)
    }
    assert.equal(init.headers.authorization, 'Bearer synthetic-github-token')
    if (path.endsWith('/actions/runs/21')) return Response.json({ ...runRecord(), status: 'completed', conclusion: 'success' })
    if (path.endsWith('/actions/artifacts/22')) return Response.json({ id: 22, expired: false,
      name: 'issue1782-github-write-prepare-21-1', workflow_run: { id: 21, head_sha: H, head_branch: BRANCH,
        repository_id: 1427517699, head_repository_id: 1427517699 }, size_in_bytes: f.archive.length, digest: 'sha256:' + hash(f.archive) })
    if (path.endsWith('/actions/artifacts/22/zip')) return new Response(null, { status: 302,
      headers: { location: 'https://synthetic.blob.core.windows.net/receipt?synthetic=signed' } })
    assert.fail('unexpected recovery URL')
  }
  assert.deepEqual((await cleanupEvidence(env(), f.b, fetchImpl)).state, receipt().state)
  assert.equal(calls.length, 4)
  const bad = async (url, init) => url.endsWith('/zip') ? new Response(null, { status: 302,
    headers: { location: 'https://foreign.test/receipt?synthetic=signed' } }) : fetchImpl(url, init)
  await assert.rejects(cleanupEvidence(env(), f.b, bad), /cleanup_evidence_invalid/)
})
test('workflow stays disabled when unbound and preserves narrow identity, credential and test scope when activated', async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const content = await readFile(resolve(root, WORKFLOW), 'utf8')
  assert.match(content, /permissions: \{\}/)
  assert.match(content, /concurrency:\n      group: production-smoke-owner-acceptance\n      cancel-in-progress: false\n      queue: max/)
  assert.match(content, /ELECTRON_SKIP_BINARY_DOWNLOAD: '1'/)
  assert.match(content, /FFMPEG_GITHUB_TOKEN: \$\{\{ github.token \}\}/)
  assert.match(content, /contents: read\n      actions: read\n      issues: read\n      id-token: write/)
  assert.equal((content.match(/identity-id: 2cf9fa19-b9db-4c08-8ca0-b31859f2cbac/g) ?? []).length, 5)
  assert.deepEqual([...content.matchAll(/secret-name: (\S+)/g)].map(match => match[1]),
    ['DATABASE_URL', 'MIKKA_DATABASE_URL', 'BETTER_AUTH_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])
  assert.equal(content.includes('workflow_dispatch'), false)
  assert.match(content, /node --test ops\/scripts\/ops\/issue1782\/github-write.test.mjs ops\/scripts\/ops\/issue1782\/github-write-guard.test.mjs/)
  assert.ok(content.indexOf('github-write-guard.mjs') < content.indexOf('Infisical/secrets-action'))
  assert.equal((content.match(/persist-credentials: false/g) ?? []).length, 2)
  if (Object.values(BINDING).every(value => value === null)) {
    assert.match(content, /if: \$\{\{ false \}\}/); assert.match(content, /MIKKA_GITHUB_REPAIR_GO: UNBOUND/); assert.match(content, /ref: UNBOUND/)
  } else {
    checkBinding()
    assert.equal(content.includes('UNBOUND'), false)
    assert.match(content, new RegExp('ref: ' + BINDING.applicationSha))
    assert.match(content, /MIKKA_GITHUB_REPAIR_GO: root-reviewed-1782-github-write-child-v1/)
    assert.equal((content.match(new RegExp('github-write-(?:guard|runner)\\.mjs --' + BINDING.operation, 'g')) ?? []).length, 2)
    assert.ok(content.includes('name: issue1782-github-write-' + BINDING.operation + '-${{ github.run_id }}-${{ github.run_attempt }}'))
  }
})
