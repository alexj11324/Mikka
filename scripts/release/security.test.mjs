import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { assessAudit } from './audit-policy.mjs'
import { admitOperations, operationsClaims, operationsInput, verifyOperationsCheckout, verifyOperationsProduct, operationsProductInput } from '../cloudflare-operations.mjs'
import { checkWorkflowRuns, releaseIdentity, RELEASE_WORKFLOWS, waitForReleaseChecks } from './ci-gate.mjs'
import { artifactInventory, pinRuntime, sealArtifact, stageDesktop, verifyArtifact } from './evidence.mjs'
import { workspaceSbom } from './workspace-sbom.mjs'

const sourceSha = 'a'.repeat(40), repository = 'alexj11324/Mikka'

test('API image merge queue admission is confined to the paired bot identity on main push', async () => {
  const yaml = createRequire(import.meta.url)('js-yaml')
  const workflow = yaml.load(await readFile(new URL('../../.github/workflows/cloudflare-api-image.yml', import.meta.url), 'utf8'))
  const allowed = new Function('github', `return ${workflow.jobs['service-plan'].if}`)
  const github = { repository_id: '1427517699', repository_owner_id: '359279274', ref: 'refs/heads/main', event_name: 'push',
    actor_id: '118344674', actor: 'github-merge-queue[bot]', triggering_actor: 'github-merge-queue[bot]' }
  assert.equal(allowed(github), true)
  assert.equal(allowed({ ...github, triggering_actor: 'alexj11324' }), true)
  assert.equal(allowed({ ...github, actor_id: '183887963', actor: 'alexj11324', triggering_actor: 'alexj11324' }), true)
  for (const patch of [{ event_name: 'workflow_dispatch' }, { event_name: 'pull_request' }, { ref: 'refs/heads/feature' },
    { repository_id: '7' }, { repository_owner_id: '7' }, { actor_id: '7' }, { actor: 'outsider' },
    { actor_id: undefined }, { triggering_actor: 'outsider' }]) assert.equal(allowed({ ...github, ...patch }), false)
})
const identity = { repository, sha: sourceSha, runId: '42', kind: 'github-actions-main' }
const run = (workflow, extra = {}) => ({ id: 1, head_sha: sourceSha, event: 'push', head_branch: 'main',
  repository: { id: 1427517699, full_name: repository, owner: { id: 183887963 } }, path: `.github/workflows/${workflow}`, status: 'completed', conclusion: 'success', ...extra })

test('release identity and exact-SHA checks reject fork/PR/old checks and a newer failed run', async () => {
  const env = { GITHUB_REPOSITORY: repository, GITHUB_REPOSITORY_ID: '1427517699', GITHUB_REPOSITORY_OWNER_ID: '183887963', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push', GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '42' }
  assert.deepEqual(releaseIdentity(env), identity)
  // A release started by the Cloudflare gateway observation keeps the same main-commit identity.
  assert.deepEqual(releaseIdentity({ ...env, GITHUB_EVENT_NAME: 'workflow_run' }), identity)
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

test('native release identity admits only the coherent transferred repository and retains original checks', async () => {
  const env = { GITHUB_REPOSITORY: 'aspectly-labs/Mikka', GITHUB_REPOSITORY_ID: '1427517699',
    GITHUB_REPOSITORY_OWNER_ID: '359279274', GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'push',
    GITHUB_SHA: sourceSha, GITHUB_RUN_ID: '42' }
  const transferred = releaseIdentity(env)
  assert.equal(transferred.repository, 'aspectly-labs/Mikka')
  for (const patch of [{ GITHUB_REPOSITORY_ID: '42' }, { GITHUB_REPOSITORY_OWNER_ID: '183887963' },
    { GITHUB_REPOSITORY: 'foreign/Mikka' }, { GITHUB_REPOSITORY_OWNER_ID: '' }]) {
    assert.throws(() => releaseIdentity({ ...env, ...patch }), /releaseMainIdentityRequired/)
  }
  assert.equal(checkWorkflowRuns(transferred, RELEASE_WORKFLOWS[0], [run(RELEASE_WORKFLOWS[0])]).state, 'success')
  for (const repository of [{ id: 42, full_name: 'aspectly-labs/Mikka' },
    { id: 1427517699, full_name: 'aspectly-labs/Mikka', owner: { id: 183887963 } }]) {
    assert.equal(checkWorkflowRuns(transferred, RELEASE_WORKFLOWS[0], [run(RELEASE_WORKFLOWS[0], { repository })]).state, 'pending')
  }
  await waitForReleaseChecks(transferred, { token: 'fixture', fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(url.pathname, '/repositories/1427517699/actions/workflows/ui-policy.yml/runs')
    return Response.json({ workflow_runs: [run(RELEASE_WORKFLOWS[0])] })
  } })
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
  const { expiresAt: _, ...openEnded } = exception
  assert.equal(assessAudit(report, lock, { ...policy, exceptions: [openEnded] }, now).allowed, true)
  assert.throws(() => assessAudit(report, lock, { ...policy, exceptions: [{ ...openEnded, reviewedAt: '2026-11-05T00:00:00Z' }] }, now), /ExceptionInvalidOrExpired/)
})

test('a transitive finding needs its own via:<package> exception', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  const lock = { lockfileVersion: 3, packages: { 'node_modules/parent': { version: '2.0.0' }, 'node_modules/child': { version: '1.0.0' } } }
  const report = { auditReportVersion: 2, metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 2, critical: 0, total: 2 } }, vulnerabilities: {
    child: { severity: 'high', nodes: ['node_modules/child'], via: [{ source: 7 }] },
    parent: { severity: 'high', nodes: ['node_modules/parent'], via: ['child'] },
  } }
  const base = { owner: 'unit-fixture-owner', reason: 'Controlled review fixture; never a production exception.', reviewedAt: '2026-10-30T00:00:00Z' }
  const child = { ...base, package: 'child', version: '1.0.0', advisory: '7' }
  const policy = { version: 1, blockSeverities: ['critical', 'high'], exceptions: [child] }
  const result = assessAudit(report, lock, policy, now)
  assert.deepEqual(result.findings.map(x => [x.package, x.advisories]), [['parent', ['via:child']]])
  const parent = { ...base, package: 'parent', version: '2.0.0', advisory: 'via:child' }
  assert.equal(assessAudit(report, lock, { ...policy, exceptions: [child, parent] }, now).allowed, true)
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

test('the release SBOM skips optional platform packages pnpm did not install, and still fails on any other missing package', async () => {
  const sourceSha = 'a'.repeat(40)
  const manifests = { root: { name: 'desktop', version: '1.0.0', dependencies: { vite: '8' } }, vite: { name: 'vite', version: '8.3.4', optionalDependencies: { fsevents: '2' } },
    esbuild: { name: 'esbuild', version: '0.28.2', optionalDependencies: { '@esbuild/aix-ppc64': '0.28.2', '@esbuild/linux-x64': '0.28.2' } },
    'esbuild-linux': { name: '@esbuild/linux-x64', version: '0.28.2' } }
  const readManifest = async path => {
    if (manifests[path]) return manifests[path]
    throw Object.assign(Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  }
  const vite = { path: 'vite', dependencies: { fsevents: { path: 'fsevents' }, esbuild: { path: 'esbuild', dependencies: { '@esbuild/aix-ppc64': { path: 'esbuild-aix' }, '@esbuild/linux-x64': { path: 'esbuild-linux' } } } } }
  const bom = await workspaceSbom([{ path: 'root', dependencies: { vite } }], { sourceSha, readManifest })
  assert.deepEqual(bom.components.map(value => value.name), ['@esbuild/linux-x64', 'esbuild', 'vite'])
  assert.deepEqual(bom.dependencies.find(value => value.ref === 'pkg:npm/esbuild@0.28.2').dependsOn, ['pkg:npm/%40esbuild/linux-x64@0.28.2'])
  await assert.rejects(workspaceSbom([{ path: 'root', dependencies: { vite: { path: 'missing' } } }], { sourceSha, readManifest }), /ENOENT/)
  await assert.rejects(workspaceSbom([{ path: 'root', dependencies: { vite } }], { sourceSha, readManifest: async path => {
    if (path === 'fsevents') throw Object.assign(Error('EACCES'), { code: 'EACCES' })
    return readManifest(path)
  } }), /EACCES/)
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

test('sealed artifacts retain either approved repository name across a transfer', async t => {
  const { rm } = await import('node:fs/promises')
  const root = await mkdtemp(join(tmpdir(), 'release-transfer-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, 'artifact'), sourceLock = join(root, 'lock')
  await mkdir(directory)
  await writeFile(sourceLock, 'fixture-lock')
  await writeFile(join(directory, 'sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', metadata: { component: { name: 'mikka', version: '1.0.0' } }, components: [] }))
  for (const repository of ['alexj11324/Mikka', 'aspectly-labs/Mikka', 'foreign/Mikka']) {
    const sealed = await sealArtifact({ directory, sourceSha, identity: { ...identity, repository }, sourceLock })
    const input = { directory, sourceSha, sourceLock, buildRunId: identity.runId, expectedManifestSha256: sealed.sha256 }
    if (repository === 'foreign/Mikka') await assert.rejects(verifyArtifact(input), /releaseSourceMismatch/)
    else assert.equal((await verifyArtifact(input)).sourceSha, sourceSha)
  }
})


function operatorEnv() {
  return {GITHUB_ACTIONS:'true', GITHUB_REPOSITORY:'alexj11324/Mikka', GITHUB_REPOSITORY_ID:'1427517699',
    GITHUB_REPOSITORY_OWNER_ID:'183887963', GITHUB_ACTOR_ID:'183887963', GITHUB_TRIGGERING_ACTOR:'alexj11324',
    GITHUB_EVENT_NAME:'workflow_dispatch', GITHUB_REF:'refs/heads/main', GITHUB_REF_NAME:'main',
    GITHUB_WORKFLOW_REF:'alexj11324/Mikka/.github/workflows/cloudflare-operations.yml@refs/heads/main',
    GITHUB_SHA:sourceSha, GITHUB_WORKFLOW_SHA:sourceSha, GITHUB_RUN_ID:'123', GITHUB_RUN_ATTEMPT:'1',
    MIKKA_CF_OPERATIONS_SHA:'b'.repeat(40), MIKKA_OPERATION:'operator-identity', MIKKA_OPERATION_ACTION:'verify',
    MIKKA_OPERATIONS_CI_RUN_ID:'321', MIKKA_OPERATIONS_CI_RUN_ATTEMPT:'2', MIKKA_OPERATIONS_CI_ARTIFACT_ID:'456',
    ACTIONS_ID_TOKEN_REQUEST_URL:'https://oidc.actions.githubusercontent.com/token', ACTIONS_ID_TOKEN_REQUEST_TOKEN:'synthetic-job-token'}
}
function operatorClaims(env = operatorEnv()) {
  return {iss:'https://token.actions.githubusercontent.com', aud:'mikka-infisical', repository:env.GITHUB_REPOSITORY,
    repository_id:env.GITHUB_REPOSITORY_ID, repository_owner_id:env.GITHUB_REPOSITORY_OWNER_ID, actor_id:env.GITHUB_ACTOR_ID,
    ref:env.GITHUB_REF, workflow_ref:env.GITHUB_WORKFLOW_REF, workflow_sha:env.GITHUB_SHA, sha:env.GITHUB_SHA,
    run_id:env.GITHUB_RUN_ID, run_attempt:env.GITHUB_RUN_ATTEMPT, environment:'cloudflare-runtime-release'}
}

test('operator admission binds the real OIDC producer before any private credential access', async () => {
  const env = operatorEnv()
  let reads = 0
  const admitted = await admitOperations(env, async (url, options) => {
    reads++
    assert.equal(url.hostname, 'oidc.actions.githubusercontent.com')
    assert.equal(url.searchParams.get('audience'), 'mikka-infisical')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer synthetic-job-token')
    return Response.json({value:'header.' + Buffer.from(JSON.stringify(operatorClaims(env))).toString('base64url') + '.signature'})
  })
  assert.equal(reads, 1)
  assert.deepEqual(admitted, {repository:'alexj11324/Mikka', operationsRepository:'alexj11324/mikka-cloud',
    driverSource:sourceSha, operationsSource:'b'.repeat(40), operation:'operator-identity', action:'verify'})
  for (const patch of [{GITHUB_EVENT_NAME:'pull_request'}, {GITHUB_REPOSITORY_OWNER_ID:'359279274'},
    {GITHUB_ACTOR_ID:'1'}, {GITHUB_TRIGGERING_ACTOR:'other'}, {GITHUB_WORKFLOW_SHA:'c'.repeat(40)},
    {GITHUB_WORKFLOW_REF:'alexj11324/Mikka/.github/workflows/cloudflare-app-deploy.yml@refs/heads/main'},
    {MIKKA_PRIVATE_GITHUB_OWNER:'foreign'}, {MIKKA_OPERATION:'shell'}, {MIKKA_OPERATION_ACTION:'exec'},
    {MIKKA_CF_OPERATIONS_SHA:'main'}, {MIKKA_OPERATIONS_CI_RUN_ID:'../123'},
    {ACTIONS_ID_TOKEN_REQUEST_URL:'https://attacker.invalid/token'}]) {
    let attempted = false
    await assert.rejects(admitOperations({...env, ...patch}, async () => { attempted = true; throw Error('unexpected provider read') }))
    assert.equal(attempted, false)
  }
  for (const key of ['iss', 'aud', 'repository', 'repository_id', 'repository_owner_id', 'actor_id',
    'ref', 'workflow_ref', 'workflow_sha', 'sha', 'run_id', 'run_attempt', 'environment']) {
    assert.throws(() => operationsClaims({...operatorClaims(env), [key]:'foreign'}, env))
  }
  const organization = {...env, GITHUB_REPOSITORY:'aspectly-labs/Mikka', GITHUB_REPOSITORY_OWNER_ID:'359279274',
    GITHUB_WORKFLOW_REF:'aspectly-labs/Mikka/.github/workflows/cloudflare-operations.yml@refs/heads/main',
    MIKKA_PRIVATE_GITHUB_OWNER:'aspectly-labs'}
  assert.equal(operationsClaims(operatorClaims(organization), organization).operationsRepository, 'aspectly-labs/mikka-cloud')
  assert.equal(operationsInput({...env, MIKKA_OPERATION:'capture-retention', MIKKA_OPERATION_ACTION:'inspect'}).operation, 'capture-retention')
  assert.throws(() => operationsInput({...env, MIKKA_OPERATION:'capture-retention', MIKKA_OPERATION_ACTION:'read'}))
  assert.equal(operationsInput({...env, MIKKA_OPERATION:'private-source-download', MIKKA_OPERATION_ACTION:'deliver', MIKKA_SOURCE_COMMENT_ID:'123'}).action, 'deliver')
  assert.throws(() => operationsInput({...env, MIKKA_OPERATION:'private-source-download', MIKKA_OPERATION_ACTION:'deliver', MIKKA_SOURCE_COMMENT_ID:'../123'}))
  assert.equal(operationsInput({...env, MIKKA_OPERATION:'vercel-project-billing', MIKKA_OPERATION_ACTION:'read', MIKKA_BILLING_FROM:'2026-11-01', MIKKA_BILLING_TO:'2026-11-20'}).action, 'read')
  for (const date of ['2026-02-30', '2026-01-01', '../2026-11-01']) assert.throws(() => operationsInput({...env, MIKKA_OPERATION:'vercel-project-billing', MIKKA_OPERATION_ACTION:'read', MIKKA_BILLING_FROM:date, MIKKA_BILLING_TO:'2026-11-20'}))
})

test('the public operator scopes source credentials, keeps provider delivery private and never publishes raw evidence', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/cloudflare-operations.yml', import.meta.url), 'utf8')
  const admission = workflow.indexOf('run: node scripts/cloudflare-operations.mjs')
  const credentials = workflow.indexOf('uses: Infisical/secrets-action@')
  const scrub = workflow.indexOf('Remove App signing credentials before loading private source')
  const checkout = workflow.indexOf('Check out the exact reviewed operations source')
  const sourceCheck = workflow.indexOf('run: node scripts/cloudflare-operations.mjs source')
  const install = workflow.indexOf('run: pnpm install --frozen-lockfile --ignore-scripts')
  const execute = workflow.indexOf('run: node operations/public-operations.mjs')
  assert.ok(admission > 0 && admission < credentials && credentials < scrub && scrub < checkout && checkout < sourceCheck && sourceCheck < install && install < execute)
  assert.match(workflow, /environment: cloudflare-runtime-release/)
  assert.match(workflow, /permission-contents: read\n\s+permission-actions: read\n\s+permission-issues: read/)
  assert.match(workflow, /repositories: mikka-cloud/)
  assert.match(workflow, /MIKKA_PUBLIC_ACTIONS_TOKEN: \$\{\{ github.token \}\}/)
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/)
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN|upload-artifact|continue-on-error|inputs\.(?:script|command|path|env)/)
})

test('marketing recovery admits only original receipt references and isolates the website read credential', async () => {
  const base = {...operatorEnv(), MIKKA_OPERATION:'marketing-cloudflare-release',
    MIKKA_OPERATION_ACTION:'rollback', MIKKA_OPERATION_RECEIPT:'123-1-' + 'b'.repeat(40) + '-' + 'c'.repeat(64),
    MIKKA_OPERATIONS_CI_RUN_ID:'', MIKKA_OPERATIONS_CI_RUN_ATTEMPT:'', MIKKA_OPERATIONS_CI_ARTIFACT_ID:'',
    MIKKA_MARKETING_GITHUB_OWNER:'aspectly-labs'}
  for (const action of ['rollback', 'rollback-legacy', 'cleanup-legacy']) {
    assert.equal(operationsInput({...base, MIKKA_OPERATION_ACTION:action}).action, action)
  }
  for (const patch of [{MIKKA_OPERATION_RECEIPT:''}, {MIKKA_OPERATION_RECEIPT:'../123'},
    {MIKKA_OPERATION_ACTION:'release'}, {MIKKA_OPERATION_ACTION:'verify'},
    {MIKKA_OPERATION_ACTION:'inspect-legacy'}, {MIKKA_MARKETING_GITHUB_OWNER:'foreign'},
    {MIKKA_OPERATIONS_CI_RUN_ID:'../123'}]) {
    let oidc = false
    await assert.rejects(admitOperations({...base, ...patch}, async () => {oidc = true; throw Error('unexpected credential admission')}))
    assert.equal(oidc, false)
  }
  const workflow = await readFile(new URL('../../.github/workflows/cloudflare-operations.yml', import.meta.url), 'utf8')
  const website = workflow.indexOf('Mint the separate read-only website credential')
  assert.ok(website > workflow.indexOf('Mint the scoped read-only operations credential')
    && website < workflow.indexOf('Remove App signing credentials before loading private source'))
  assert.match(workflow, /owner: \$\{\{ steps\.marketing-app\.outputs\.owner \}\}\n\s+repositories: mikka-web\n\s+permission-contents: read/)
  assert.match(workflow, /MIKKA_MARKETING_READ_TOKEN: \$\{\{ steps\.marketing-token\.outputs\.token \}\}/)
  assert.match(workflow, /MIKKA_OPERATION_RECEIPT: \$\{\{ inputs\.operation_receipt \}\}/)
})

test('runtime operations reject unrelated receipts or incomplete activation before OIDC', async () => {
  const receipt = '123-1-' + 'b'.repeat(40) + '-' + 'c'.repeat(64)
  const base = {...operatorEnv(), MIKKA_OPERATION:'runtime-native-alert', MIKKA_OPERATION_ACTION:'enable',
    MIKKA_ALERT_SCOPE:'filesystem', MIKKA_ALERT_ENROLLMENT:receipt,
    MIKKA_PROMOTION_POST:'123-' + 'd'.repeat(64), MIKKA_PREPARATION_RUN:'321-1', MIKKA_OBSERVATION_RUN:'456-1'}
  assert.equal(operationsInput(base).action, 'enable')
  for (const patch of [{MIKKA_ALERT_SCOPE:'all'}, {MIKKA_ALERT_ENROLLMENT:''},
    {MIKKA_PROMOTION_POST:'https://example.invalid'}, {MIKKA_PREPARATION_RUN:'321'},
    {MIKKA_OBSERVATION_RUN:'private-123'}, {MIKKA_OPERATION_ACTION:'prepare'},
    {MIKKA_OPERATION_ACTION:'disable'}]) {
    let oidc = false
    await assert.rejects(admitOperations({...base, ...patch}, async () => {oidc = true; throw Error('unexpected admission')}))
    assert.equal(oidc, false)
  }
  const observe = {...operatorEnv(), MIKKA_OPERATION:'observe-cloudflare-runtime', MIKKA_OPERATION_ACTION:'read',
    MIKKA_OPERATOR_PRODUCT_SHA:sourceSha, MIKKA_PROMOTION_POST:base.MIKKA_PROMOTION_POST,
    MIKKA_PREPARATION_RUN:'321-1', MIKKA_OBSERVATION_HISTORY:Array.from({length:8}, (_, index) => `${123 + index}-1-` + 'b'.repeat(40) + '-' + 'c'.repeat(64)).join(','),
    MIKKA_PRESSURE_ENROLLMENT:'456-1'}
  assert.equal(operationsInput(observe).action, 'read')
  for (const history of ['../123', receipt, Array(8).fill(receipt).join(','), Array(9).fill(receipt).join(',')]) {
    assert.throws(() => operationsInput({...observe, MIKKA_OBSERVATION_HISTORY:history}))
  }
  const workflow = await readFile(new URL('../../.github/workflows/cloudflare-operations.yml', import.meta.url), 'utf8')
  const choices = /action:\n[\s\S]*?options: \[([^\]]+)\]/.exec(workflow)?.[1].split(',').map(value => value.trim())
  for (const action of ['prepare', 'enable', 'disable']) assert.ok(choices?.includes(action), 'Native alert action is not dispatchable: ' + action)
})

test('model and daemon drivers come only from the reviewed fixed private request files', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'operations-driver-')))
  t.after(() => rm(directory, {recursive:true, force:true}))
  const env = {...operatorEnv(), MIKKA_OPERATION:'product-task-canary', MIKKA_OPERATION_ACTION:'verify'}
  await assert.rejects(operationsProductInput(env, {directory}))
  await mkdir(join(directory, '.github/release-requests'), {recursive:true})
  const canary = join(directory, '.github/release-requests/product-task-canary.json')
  await writeFile(canary, JSON.stringify({version:2, public_sha:sourceSha}))
  assert.deepEqual(await operationsProductInput(env, {directory}), {source:sourceSha, directory:'public-source', browser:true})
  await writeFile(canary, JSON.stringify({version:2, public_sha:'main'}))
  await assert.rejects(operationsProductInput(env, {directory}))
  await rm(canary)
  await writeFile(join(directory, 'unreviewed.json'), JSON.stringify({version:2, public_sha:sourceSha}))
  await symlink(join(directory, 'unreviewed.json'), canary)
  await assert.rejects(operationsProductInput(env, {directory}))
  await mkdir(join(directory, 'docs/operations/releases'), {recursive:true})
  await writeFile(join(directory, 'docs/operations/releases/daemon-qualification.json'), JSON.stringify({driver:sourceSha}))
  assert.deepEqual(await operationsProductInput({...env, MIKKA_OPERATION:'production-daemon-qualification'}, {directory}),
    {source:sourceSha, directory:'product', browser:false})
})


test('the public source fence rejects unmerged or dirty operations before private installation', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'protected-operations-source-')))
  t.after(() => rm(directory, {recursive:true, force:true}))
  await mkdir(join(directory, 'operations'))
  await writeFile(join(directory, 'operations/public-operations.mjs'), 'export const reviewed = true\n')
  const git = args => execFileSync('git', ['-C', directory, ...args], {encoding:'utf8', stdio:['ignore', 'pipe', 'pipe']}).trim()
  git(['init', '--quiet'])
  git(['remote', 'add', 'origin', 'https://github.com/alexj11324/mikka-cloud.git'])
  git(['add', '.'])
  git(['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'reviewed main'])
  const main = git(['rev-parse', 'HEAD'])
  let canonicalMain = main
  const env = {...operatorEnv(), GH_TOKEN:'synthetic-private-source-token', MIKKA_CF_OPERATIONS_SHA:main}
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer synthetic-private-source-token')
    if (url === 'https://api.github.com/repositories/1448851980') return Response.json({id:1448851980,
      full_name:'alexj11324/mikka-cloud', private:true, fork:false, owner:{id:183887963}})
    assert.equal(url, 'https://api.github.com/repositories/1448851980/git/ref/heads/main')
    return Response.json({object:{type:'commit', sha:canonicalMain}})
  }
  assert.equal((await verifyOperationsCheckout(env, {directory, fetchImpl})).operationsSource, main)
  await writeFile(join(directory, 'operations/public-operations.mjs'), 'export const reviewed = false\n')
  await assert.rejects(verifyOperationsCheckout(env, {directory, fetchImpl}))
  git(['add', '.'])
  git(['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'unmerged request'])
  const pending = git(['rev-parse', 'HEAD'])
  await assert.rejects(verifyOperationsCheckout({...env, MIKKA_CF_OPERATIONS_SHA:pending}, {directory, fetchImpl}))
  canonicalMain = pending
  assert.equal((await verifyOperationsCheckout({...env, MIKKA_CF_OPERATIONS_SHA:pending}, {directory, fetchImpl})).operationsSource, pending)
})


test('the legacy inventory SDK source is an exact public main ancestor before dependency installation', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'protected-inventory-source-')))
  t.after(() => rm(directory, {recursive:true, force:true}))
  await mkdir(join(directory, 'scripts/ops'), {recursive:true})
  for (const file of ['package.json', 'pnpm-lock.yaml', 'scripts/ops/vercel-workflow-inventory.mjs']) await writeFile(join(directory, file), '{}\n')
  const git = args => execFileSync('git', ['-C', directory, ...args], {encoding:'utf8', stdio:['ignore', 'pipe', 'pipe']}).trim()
  git(['init', '--quiet'])
  git(['remote', 'add', 'origin', 'https://github.com/alexj11324/Mikka.git'])
  git(['add', '.'])
  git(['-c', 'user.name=CI fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'public inventory reader'])
  const source = git(['rev-parse', 'HEAD'])
  const env = {...operatorEnv(), MIKKA_OPERATION:'vercel-workflow-inventory', MIKKA_OPERATION_ACTION:'read',
    MIKKA_OPERATOR_PRODUCT_SHA:source, MIKKA_OBSERVE_ORIGINAL_EVE:'true', MIKKA_PUBLIC_ACTIONS_TOKEN:'synthetic-public-token'}
  let mainAncestor = true
  const fetchImpl = async (url, options) => {
    assert.equal(url, `https://api.github.com/repositories/1427517699/compare/${source}...${env.GITHUB_SHA}?per_page=1`)
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer synthetic-public-token')
    return Response.json({url:`https://api.github.com/repos/alexj11324/Mikka/compare/${source}...${env.GITHUB_SHA}`,
      base_commit:{sha:source}, merge_base_commit:{sha:mainAncestor ? source : 'c'.repeat(40)},
      status:mainAncestor ? 'ahead' : 'diverged', behind_by:mainAncestor ? 0 : 1, ahead_by:1})
  }
  assert.equal((await verifyOperationsProduct(env, {directory, fetchImpl})).productSource, source)
  mainAncestor = false
  await assert.rejects(verifyOperationsProduct(env, {directory, fetchImpl}))
  mainAncestor = true
  await writeFile(join(directory, 'pnpm-lock.yaml'), 'dirty\n')
  await assert.rejects(verifyOperationsProduct(env, {directory, fetchImpl}))
  await assert.rejects(verifyOperationsProduct({...env, MIKKA_OPERATOR_PRODUCT_SHA:sourceSha}, {directory, fetchImpl}))
})
