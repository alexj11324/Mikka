import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { checkedMobilePublication, latestMobilePublication, mobileInputs, OTA_SOURCE_ARTIFACT, selectMobilePublication,
  sourceReceipt } from './mobile-ota-source.mjs'
import { downloadReleaseReport } from '../acceptance/task-secrets-ci.mjs'

const repository = { id: 1427517699, full_name: 'alexj11324/Mikka', private: false, fork: false }
const source = 'a'.repeat(40), overlay = 'b'.repeat(40), inputs = { mobile: 'c'.repeat(40), protocol: 'd'.repeat(40), overlayMobile: 'e'.repeat(40) }
const now = Date.parse('2026-11-20T12:00:00Z')
function fixture(id = 10, created = '2026-11-20T10:00:05Z') {
  const receipt = { version: 1, kind: 'mobile-ota-source', runId: String(id), runAttempt: '1', sourceCommit: source, overlayCommit: overlay, inputs }
  const run = { id, run_attempt: 1, repository, head_repository: repository, head_sha: source, head_branch: 'main',
    path: '.github/workflows/mobile-update.yml', event: 'workflow_run', actor: { id: 183887963 }, triggering_actor: { id: 183887963 },
    status: 'completed', conclusion: 'success' }
  const jobs = [{ id: id + 100, run_id: id, run_attempt: 1, head_sha: source, name: 'EAS Update', status: 'completed', conclusion: 'success',
    steps: [
      { name: 'Compare actual mobile release inputs', number: 10, conclusion: 'success' },
      { name: 'Preserve the immutable mobile source receipt', number: 11, conclusion: 'success' },
      { name: 'Recheck the owner window immediately before publication', number: 12, conclusion: 'success' },
      { name: 'Publish to production', number: 13, conclusion: 'success', started_at: '2026-11-20T10:02:00Z', completed_at: '2026-11-20T10:03:00Z' },
    ] }]
  const artifact = { id: id + 200, name: OTA_SOURCE_ARTIFACT, expired: false, created_at: created, expires_at: '2027-01-01T00:00:00Z',
    size_in_bytes: 1000, digest: 'sha256:' + 'f'.repeat(64),
    url: `https://api.github.com/repos/alexj11324/Mikka/actions/artifacts/${id + 200}`,
    archive_download_url: `https://api.github.com/repos/alexj11324/Mikka/actions/artifacts/${id + 200}/zip`,
    workflow_run: { id, repository_id: repository.id, head_repository_id: repository.id, head_sha: source, head_branch: 'main' } }
  return { receipt, run, jobs, artifact }
}

test('only the original production publish step turns an immutable source receipt into publication evidence', () => {
  const f = fixture()
  assert.equal(checkedMobilePublication(f.run, f.jobs, f.artifact, f.receipt).status, 'published')
  f.run.conclusion = 'failure'; f.jobs[0].conclusion = 'failure'
  assert.equal(checkedMobilePublication(f.run, f.jobs, f.artifact, f.receipt).status, 'published', 'a later cleanup error cannot undo a completed OTA')
  f.run.conclusion = 'success'; f.jobs[0].conclusion = 'success'
  for (const conclusion of ['skipped', 'failure', 'cancelled', null]) {
    f.jobs[0].steps.at(-1).conclusion = conclusion
    assert.deepEqual(checkedMobilePublication(f.run, f.jobs, f.artifact, f.receipt), { status: 'unconfirmed' })
  }
})

test('publication provenance rejects another attempt, source, actor, fork, step order or unuploaded receipt', () => {
  for (const change of [
    f => { f.run.run_attempt = 2 }, f => { f.jobs[0].run_attempt = 2 }, f => { f.run.head_sha = overlay },
    f => { f.run.triggering_actor = { id: 1 } }, f => { f.run.head_repository = { ...repository, fork: true } },
    f => { f.jobs[0].steps[1].number = 20 }, f => { f.jobs[0].steps[1].conclusion = 'failure' },
  ]) {
    const f = fixture(); change(f)
    assert.throws(() => checkedMobilePublication(f.run, f.jobs, f.artifact, f.receipt))
  }
  assert.throws(() => sourceReceipt({ ...fixture().receipt, token: 'unwanted-field' }))
})

test('organization-hosted publication retains official repository identity checks', async () => {
  const f = fixture()
  f.run.repository = f.run.head_repository = { ...repository, full_name: 'aspectly-labs/Mikka' }
  f.artifact.url = f.artifact.url.replace('alexj11324', 'aspectly-labs')
  f.artifact.archive_download_url = f.artifact.url + '/zip'
  assert.equal((await latestMobilePublication({ ...history([f], []), repository: 'aspectly-labs/Mikka' })).status, 'published')
  f.run.head_repository = { ...f.run.head_repository, id: 1 }
  await assert.rejects(latestMobilePublication({ ...history([f], []), repository: 'aspectly-labs/Mikka' }))
})

function history(rows, downloaded) {
  return {
    now,
    json: async path => {
      if (path.startsWith('actions/artifacts?')) return { total_count: rows.length, artifacts: rows.map(row => row.artifact) }
      for (const row of rows) {
        const run = `actions/runs/${row.run.id}`
        if (path === run || path === run + '/attempts/1') return row.run
        if (path === run + '/attempts/1/jobs?per_page=100&page=1') return { total_count: row.jobs.length, jobs: row.jobs }
      }
      assert.fail('unexpected read-only GitHub path: ' + path)
    },
    download: async proof => {
      downloaded.push(proof.artifact.id)
      return Buffer.from(JSON.stringify(rows.find(row => row.artifact.id === proof.artifact.id).receipt))
    },
  }
}

test('a source receipt uploaded before a failed or cancelled publish blocks automatic OTA without falling back', async () => {
  const older = fixture(), newer = fixture(20, '2026-11-20T10:01:00Z'), downloaded = []
  for (const conclusion of ['failure', 'cancelled', 'skipped']) {
    newer.jobs[0].steps.at(-1).conclusion = conclusion
    const baseline = await latestMobilePublication(history([older, newer], downloaded))
    assert.equal(baseline.status, 'unconfirmed')
    assert.deepEqual(selectMobilePublication(newer.receipt, baseline, 'workflow_run'), { selected: false, reason: 'mobile_baseline_unconfirmed' })
  }
  assert.deepEqual(downloaded, [newer.artifact.id, newer.artifact.id, newer.artifact.id])
})

test('expired or missing latest evidence requires an owner dispatch; malformed evidence never borrows an older receipt', async () => {
  const older = fixture(), newer = fixture(20, '2026-11-20T10:01:00Z'), downloaded = []
  newer.artifact.expired = true
  const expired = await latestMobilePublication(history([newer, older], downloaded))
  assert.deepEqual(expired, { status: 'expired' }); assert.deepEqual(downloaded, [])
  assert.equal(selectMobilePublication(newer.receipt, expired, 'push').selected, false)
  assert.deepEqual(selectMobilePublication(newer.receipt, expired, 'workflow_dispatch'), { selected: true, reason: 'owner_bootstrap_expired' })
  const missing = await latestMobilePublication(history([], downloaded))
  assert.deepEqual(selectMobilePublication(newer.receipt, missing, 'workflow_run'), { selected: false, reason: 'mobile_baseline_missing' })
  assert.equal(selectMobilePublication(newer.receipt, missing, 'workflow_dispatch').selected, true)
  newer.artifact.expired = false; newer.receipt.runAttempt = '2'
  await assert.rejects(latestMobilePublication(history([older, newer], downloaded)))
  assert.deepEqual(downloaded, [newer.artifact.id])
})

test('actual Git trees preserve deferred mobile changes across later Web merges and ignore Web-only overlays', async t => {
  const root = await mkdtemp(join(tmpdir(), 'mobile-ota-source-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const product = join(root, 'product'), ui = join(root, 'ui')
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const commit = cwd => { git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture'); return git(cwd, 'rev-parse', 'HEAD') }
  await mkdir(join(product, 'apps/mobile'), { recursive: true }); await mkdir(join(product, 'packages/protocol'), { recursive: true })
  await mkdir(join(ui, 'mobile'), { recursive: true })
  for (const directory of [product, ui]) git(directory, 'init', '-q')
  await writeFile(join(product, 'apps/mobile/view.tsx'), 'old reader')
  await writeFile(join(product, 'packages/protocol/version.ts'), 'version one')
  await writeFile(join(ui, 'mobile/view.tsx'), 'official mobile')
  const firstSource = commit(product), firstOverlay = commit(ui)
  const first = mobileInputs(product, ui, firstSource, firstOverlay), baseline = { status: 'published', receipt: first }
  const runner = join(root, 'runner')
  await mkdir(join(runner, 'mobile-ota-source'), { recursive: true })
  await symlink(ui, join(product, '.hosted-ui'))
  await writeFile(join(runner, 'mobile-ota-source/release.json'), JSON.stringify({ ...first, version: 1, kind: 'mobile-ota-source', runId: '10', runAttempt: '1' }))
  const env = { ...process.env, GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'aspectly-labs/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
    GITHUB_REPOSITORY_OWNER_ID: '359279274', GITHUB_ACTOR_ID: '183887963', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'aspectly-labs/Mikka/.github/workflows/mobile-update.yml@refs/heads/main', GITHUB_WORKFLOW_SHA: firstSource,
    GITHUB_SHA: firstSource, GITHUB_WORKSPACE: product, OVERLAY_SHA: firstOverlay, GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_RUN_ID: '10', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: runner }
  execFileSync(process.execPath, [new URL('./mobile-ota-source.mjs', import.meta.url).pathname, 'verify'], { env })
  assert.throws(() => execFileSync(process.execPath, [new URL('./mobile-ota-source.mjs', import.meta.url).pathname, 'verify'], {
    env: { ...env, GITHUB_REPOSITORY_OWNER_ID: '183887963' }, stdio: 'pipe',
  }))
  await writeFile(join(product, 'web-only.txt'), 'new web')
  await writeFile(join(ui, 'web-only.txt'), 'new web overlay')
  const web = mobileInputs(product, ui, commit(product), commit(ui))
  assert.equal(selectMobilePublication(web, baseline, 'workflow_run').selected, false)
  await writeFile(join(product, 'apps/mobile/view.tsx'), 'new mobile reader'); commit(product)
  await writeFile(join(product, 'web-only.txt'), 'later superseding web merge')
  const deferred = mobileInputs(product, ui, commit(product), git(ui, 'rev-parse', 'HEAD'))
  assert.equal(selectMobilePublication(deferred, baseline, 'workflow_run').selected, true)
  assert.equal(selectMobilePublication(deferred, { status: 'published', receipt: deferred }, 'workflow_run').selected, false)
  await writeFile(join(ui, 'mobile/view.tsx'), 'new official mobile')
  const newOverlay = mobileInputs(product, ui, deferred.sourceCommit, commit(ui))
  assert.equal(selectMobilePublication(newOverlay, { status: 'published', receipt: deferred }, 'workflow_run').selected, true)
  await writeFile(join(product, 'apps/mobile/view.tsx'), 'uncommitted replacement')
  assert.throws(() => mobileInputs(product, ui, deferred.sourceCommit, newOverlay.overlayCommit))
})

test('the existing bounded archive reader verifies the native digest and never forwards its token to storage', async () => {
  const bytes = Buffer.from(JSON.stringify(fixture().receipt))
  const archive = execFileSync('python3', ['-c', 'import io,sys,zipfile\nb=io.BytesIO()\nwith zipfile.ZipFile(b,"w",zipfile.ZIP_DEFLATED) as z: z.writestr("release.json",sys.stdin.buffer.read())\nsys.stdout.buffer.write(b.getvalue())'], { input: bytes })
  const { createHash } = await import('node:crypto')
  const proof = { selected: true, artifact: { id: 210, sizeBytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') } }
  const fetched = await downloadReleaseReport(proof, { token: 'read-only-fixture', repository: 'aspectly-labs/Mikka', fetchImpl: async (url, init) => {
    if (url.startsWith('https://api.github.com/')) {
      assert.equal(url, 'https://api.github.com/repos/aspectly-labs/Mikka/actions/artifacts/210/zip')
      assert.equal(init.headers.authorization, 'Bearer read-only-fixture')
      return new Response(null, { status: 302, headers: { location: 'https://productionresultssa12.blob.core.windows.net/receipt' } })
    }
    assert.equal(init.headers, undefined)
    return new Response(archive)
  } })
  assert.deepEqual(sourceReceipt(JSON.parse(fetched)), fixture().receipt)
})
