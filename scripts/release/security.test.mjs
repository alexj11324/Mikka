import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assessAudit } from './audit-policy.mjs'
import { checkWorkflowRuns, releaseIdentity, RELEASE_WORKFLOWS, waitForReleaseChecks } from './ci-gate.mjs'
import { artifactInventory, pinRuntime, sealArtifact, stageDesktop, verifyArtifact } from './evidence.mjs'
import { workspaceSbom } from './workspace-sbom.mjs'

const sourceSha = 'a'.repeat(40), repository = 'alexj11324/Mikka'
const identity = { repository, sha: sourceSha, runId: '42', kind: 'github-actions-main' }
const run = (workflow, extra = {}) => ({ id: 1, head_sha: sourceSha, event: 'push', head_branch: 'main',
  repository: { full_name: repository }, path: `.github/workflows/${workflow}`, status: 'completed', conclusion: 'success', ...extra })

test('release identity and exact-SHA checks reject fork/PR/old checks and a newer failed run', async () => {
  const env = { GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '42' }
  assert.deepEqual(releaseIdentity(env), identity)
  for (const changed of [{ GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_REPOSITORY: 'fixture/fork' }, { GITHUB_EVENT_NAME: 'pull_request' }])
    assert.throws(() => releaseIdentity({ ...env, ...changed }), /releaseMainIdentityRequired/)
  assert.equal(checkWorkflowRuns(identity, RELEASE_WORKFLOWS[0], [run(RELEASE_WORKFLOWS[0], { head_sha: 'b'.repeat(40) })]).state, 'pending')
  assert.equal(checkWorkflowRuns(identity, RELEASE_WORKFLOWS[0], [run(RELEASE_WORKFLOWS[0], { event: 'pull_request' })]).state, 'pending')
  assert.throws(() => checkWorkflowRuns(identity, RELEASE_WORKFLOWS[0], [run(RELEASE_WORKFLOWS[0]), run(RELEASE_WORKFLOWS[0], { id: 2, conclusion: 'failure' })]), /releaseCheckFailed/)
  assert.equal(checkWorkflowRuns(identity, RELEASE_WORKFLOWS[0], [run(RELEASE_WORKFLOWS[0], { conclusion: 'failure' }), run(RELEASE_WORKFLOWS[0], { id: 2 })]).state, 'success')
  const calls = []
  const result = await waitForReleaseChecks(identity, { token: 'unit-fixture-only', fetchImpl: async url => {
    calls.push(url); const workflow = url.pathname.split('/').at(-2)
    return Response.json({ workflow_runs: [run(workflow)] })
  } })
  assert.equal(result.length, RELEASE_WORKFLOWS.length)
  assert.ok(calls.every(url => url.searchParams.get('head_sha') === sourceSha && url.searchParams.get('event') === 'push'))
  await assert.rejects(waitForReleaseChecks(identity, { token: 'unit-fixture-only', timeoutMs: 0,
    fetchImpl: async () => Response.json({ workflow_runs: [] }) }), /releaseChecksIncomplete/)
  await assert.rejects(waitForReleaseChecks(identity, { token: 'unit-fixture-only', fetchImpl: async () => new Response(null, { status: 403 }) }), /releaseChecksUnavailable/)
})

test('artifact, SBOM, source, source-lock and trusted manifest digest stay bound across publication/rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-release-evidence-')), directory = join(root, 'artifact'), sourceLock = join(root, 'pnpm-lock.yaml')
  await mkdir(directory)
  await writeFile(sourceLock, 'controlled-lock-version\n')
  await writeFile(join(directory, 'mikka.js'), 'export const release = 1\n')
  await writeFile(join(directory, 'sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.6', metadata: { component: { name: 'mikka', version: '1.0.0' } }, components: [{ name: 'runtime', version: '1.2.3' }] }))
  const sealed = await sealArtifact({ directory, sourceSha, identity, sourceLock })
  const input = { directory, sourceSha, sourceLock, buildRunId: identity.runId, expectedManifestSha256: sealed.sha256 }
  assert.equal((await verifyArtifact(input)).sourceSha, sourceSha)
  await assert.rejects(verifyArtifact({ ...input, sourceSha: 'b'.repeat(40) }), /releaseSourceMismatch/)
  await assert.rejects(verifyArtifact({ ...input, buildRunId: '43' }), /releaseSourceMismatch/)
  await writeFile(join(directory, 'mikka.js'), 'export const release = 2\n')
  await assert.rejects(verifyArtifact(input), /releaseArtifactMismatch/)
  await writeFile(join(directory, 'mikka.js'), 'export const release = 1\n')
  await writeFile(sourceLock, 'different-lock\n')
  await assert.rejects(verifyArtifact(input), /releaseSourceLockMismatch/)
  await writeFile(sourceLock, 'controlled-lock-version\n')
  await writeFile(join(directory, 'mikka-release-manifest.json'), JSON.stringify({ ...sealed.manifest, buildRunId: '43' }))
  await assert.rejects(verifyArtifact(input), /releaseManifestMismatch/)
  const link = join(directory, 'linked.js'); await symlink(join(directory, 'mikka.js'), link)
  await assert.rejects(artifactInventory(directory), /releaseArtifactSymlinkRejected/)
})

test('published direct runtime versions come from installed package manifests instead of floating ranges', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-release-runtime-')), directory = join(root, 'out'), source = join(root, 'source')
  await mkdir(directory); await mkdir(join(source, 'node_modules', 'runtime'), { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'mikka', dependencies: { runtime: '^1.0.0' } }))
  await writeFile(join(source, 'node_modules', 'runtime', 'package.json'), JSON.stringify({ name: 'runtime', version: '1.2.3' }))
  await pinRuntime(directory, source)
  assert.equal(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')).dependencies.runtime, '1.2.3')
})

test('known high vulnerabilities, malformed audit results and expired exceptions prevent release', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  const lock = { lockfileVersion: 3, packages: { 'node_modules/controlled-vulnerable-fixture': { version: '1.0.0' } } }
  const report = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 } }, vulnerabilities: {
    'controlled-vulnerable-fixture': { severity: 'high', nodes: ['node_modules/controlled-vulnerable-fixture'], via: [{ source: 42 }] },
  } }
  const policy = { version: 1, blockSeverities: ['critical', 'high'], exceptions: [] }
  assert.equal(assessAudit(report, lock, policy, now).allowed, false)
  const exception = { package: 'controlled-vulnerable-fixture', version: '1.0.0', advisory: '42', owner: 'unit-fixture-owner',
    reason: 'Controlled review fixture; never a production exception.', reviewedAt: '2026-10-30T00:00:00Z', expiresAt: '2026-11-02T00:00:00Z' }
  assert.equal(assessAudit(report, lock, { ...policy, exceptions: [exception] }, now).allowed, true)
  assert.throws(() => assessAudit(report, lock, { ...policy, exceptions: [{ ...exception, expiresAt: '2026-10-30T12:00:00Z' }] }, now), /ExceptionInvalidOrExpired/)
  assert.equal(assessAudit(report, lock, { ...policy, exceptions: [{ ...exception, version: '0.9.0' }] }, now).allowed, false)
  assert.throws(() => assessAudit({ error: { code: 'network' } }, lock, policy, now), /ReportUnavailable/)
  assert.throws(() => assessAudit(report, { lockfileVersion: 3, packages: {} }, policy, now), /LockMismatch/)
  assert.throws(() => assessAudit({ ...report, vulnerabilities: {} }, lock, policy, now), /FindingMissing/)
  const pnpm = { metadata: report.metadata, advisories: { '42': { module_name: 'controlled-vulnerable-fixture', severity: 'high', findings: [{ version: '1.0.0' }] } } }
  assert.equal(assessAudit(pnpm, null, policy, now).allowed, false)
  assert.equal(assessAudit(pnpm, null, { ...policy, exceptions: [exception] }, now).allowed, true)
  assert.throws(() => assessAudit({ ...pnpm, muted: [{ id: 42 }] }, null, policy, now), /ReportUnavailable/)
  assert.throws(() => assessAudit({ ...pnpm, advisories: {} }, null, policy, now), /FindingMissing/)
})

test('desktop staging publishes only intended installers and the selected production SBOM graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-release-desktop-')), source = join(root, 'build'), out = join(root, 'candidate')
  await mkdir(source)
  for (const file of ['Mikka-1.0.0.zip', 'Mikka-1.0.0.dmg', 'Mikka-1.0.0.zip.blockmap', 'latest-mac.yml']) await writeFile(join(source, file), file)
  await writeFile(join(source, 'builder-debug.yml'), 'configuration is not a public artifact')
  await mkdir(join(source, 'mac-arm64'))
  await stageDesktop(source, out)
  const files = await artifactInventory(out)
  assert.ok(files.some(file => file.path === 'SHA256SUMS.txt'))
  assert.ok(!files.some(file => file.path === 'builder-debug.yml' || file.path.includes('mac-arm64')))
  const manifests = { root: { name: 'desktop', version: '1.0.0', license: 'MIT' }, runtime: { name: 'runtime', version: '2.0.0', license: 'MIT' },
    dev: { name: 'not-shipped', version: '3.0.0' }, bundled: { name: 'electron', version: '45.1.0' } }
  const bom = await workspaceSbom([{ path: 'root', dependencies: { runtime: { path: 'runtime' } }, devDependencies: { electron: { path: 'bundled' }, dev: { path: 'dev' } }, unsavedDependencies: { dev: { path: 'dev' } } }],
    { sourceSha, bundledEntries: ['electron'], readManifest: async path => manifests[path] })
  assert.deepEqual(bom.components.map(value => value.name), ['electron', 'runtime'])
  assert.equal(bom.metadata.properties[0].value, sourceSha)
})

test('third-party actions in workflows and local composite actions use immutable SHA refs', async () => {
  for (const folder of ['workflows', 'actions']) {
    const directory = new URL(`../../.github/${folder}/`, import.meta.url)
    for (const name of await readdir(directory, { recursive: true })) {
      if (!/\.ya?ml$/.test(name)) continue
      const content = await readFile(new URL(name, directory), 'utf8')
      for (const match of content.matchAll(/uses:\s+([^\s#]+)/g)) {
        if (!match[1].startsWith('./')) assert.match(match[1], /^[^@]+@[a-f0-9]{40}$/, `${folder}/${name}: ${match[1]}`)
      }
    }
  }
})
