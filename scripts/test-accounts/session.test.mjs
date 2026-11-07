import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, chmod, symlink, readdir, lstat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { auditEvidence } from './session.mjs'

async function fixture(use) {
  const root = await mkdtemp(join(tmpdir(), 'mikka-evidence-test-'))
  const stateDirectory = join(root, 'private')
  const evidence = join(root, 'evidence')
  const credentialFile = join(stateDirectory, 'credentials', 'synthetic.json')
  const password = randomBytes(32).toString('base64url')
  const cookie = `${randomBytes(32).toString('base64url')}.$+/=`
  try {
    await mkdir(join(stateDirectory, 'credentials'), { recursive: true, mode: 0o700 })
    await mkdir(evidence, { mode: 0o700 })
    await writeFile(credentialFile, JSON.stringify({ password }), { mode: 0o600 })
    await writeFile(join(stateDirectory, 'secret-audit.jsonl'), `${JSON.stringify({ values: [cookie] })}\n`, { mode: 0o600 })
    const audit = paths => auditEvidence(paths, { environment: { instanceId: 'synthetic' }, stateDirectory })
    await use({ audit, evidence, password, cookie, credentialFile, root })
  } finally { console.error(`Retained test fixture directory: ${root}`) }
}

test('evidence scanner accepts an explicit secret-free report and binary file', async () => {
  await fixture(async ({ audit, evidence }) => {
    await writeFile(join(evidence, 'report.json'), JSON.stringify({ tests: 10, failures: 0 }))
    await writeFile(join(evidence, 'screenshot.png'), Buffer.from([137, 80, 78, 71, 0, 1, 2]))
    const result = await audit([evidence])
    assert.equal(result.result, 'passed')
    assert.equal(result.files, 2)
  })
})

test('evidence scanner rejects exact credentials, cookies and common encoded forms without echoing them', async () => {
  await fixture(async ({ audit, evidence, password, cookie }) => {
    const file = join(evidence, 'report.txt')
    for (const value of [password, cookie, encodeURIComponent(cookie), Buffer.from(cookie).toString('base64')]) {
      await writeFile(file, `prefix ${value} suffix`)
      await assert.rejects(audit([file]), error => {
        assert.equal(error.code, 'EVIDENCE_SECRET_DETECTED')
        assert.equal(error.message, 'EVIDENCE_SECRET_DETECTED')
        return true
      })
    }
    // Binary evidence metadata is scanned too; the scanner does not claim OCR.
    await writeFile(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 0]), Buffer.from(cookie)]))
    await assert.rejects(audit([file]), { code: 'EVIDENCE_SECRET_DETECTED' })
  })
})

test('evidence scanner refuses archives, request recordings, video and symlinks', async () => {
  await fixture(async ({ audit, evidence }) => {
    for (const suffix of ['zip', 'har', 'webm', 'mp4', 'trace', 'network', 'stacks']) {
      const file = join(evidence, `unreviewed.${suffix}`)
      await writeFile(file, '')
      await assert.rejects(audit([file]), { code: 'UNREVIEWED_SECRET_BEARING_EVIDENCE' })
    }
    const rawTraceDirectory = join(evidence, 'trace')
    await mkdir(rawTraceDirectory)
    await writeFile(join(rawTraceDirectory, 'plain.txt'), 'no known secret, still a raw recording')
    await assert.rejects(audit([rawTraceDirectory]), { code: 'UNREVIEWED_SECRET_BEARING_EVIDENCE' })
    const file = join(evidence, 'safe.txt')
    const link = join(evidence, 'link.txt')
    await writeFile(file, 'no secret')
    await symlink(file, link)
    await assert.rejects(audit([link]), { code: 'EVIDENCE_SYMLINK_FORBIDDEN' })
  })
})

test('evidence scanner rejects an unsafe credential source instead of silently omitting it', async () => {
  await fixture(async ({ audit, evidence, credentialFile }) => {
    await writeFile(join(evidence, 'report.txt'), 'no secret')
    await chmod(credentialFile, 0o644)
    await assert.rejects(audit([evidence]), { code: 'PRIVATE_FILE_UNSAFE' })
  })
})

test('a pre-account startup log uses the real runner secret inventory and keeps missing stores fail closed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-pre-account-evidence-'))
  const environment = {
    version: 1, id: 'pre-account-fixture', kind: 'isolated-ci', origin: 'http://localhost:3100', basePath: '/mikka',
    deploymentSha: 'a'.repeat(40), database: { host: '127.0.0.1', port: 5432, name: 'mikka_e2e', schema: 'public', user: 'e2e' },
    instanceId: randomUUID(), capabilities: { provision: true, mail: 'disabled', reset: true },
  }
  const authSecret = `${randomBytes(32).toString('base64url')}/+=`
  const databasePassword = randomBytes(32).toString('base64url')
  const cookie = `${randomBytes(32).toString('base64url')}.session`
  const databaseURL = `postgresql://e2e:${databasePassword}@127.0.0.1:5432/mikka_e2e`
  const environmentFile = join(root, 'environment.json')
  const evidence = join(root, 'startup.log')
  // No CI-only flags or database connection: these child processes exercise only
  // the real filesystem registry and the read-only audit CLI with synthetic data.
  const env = {
    PATH: process.env.PATH,
    E2E_DATABASE_URL: databaseURL, MIKKA_DATABASE_URL: databaseURL, DATABASE_URL: databaseURL,
    BETTER_AUTH_URL: environment.origin, BETTER_AUTH_SECRET: authSecret,
    MIKKA_TEST_DEPLOYMENT_SHA: environment.deploymentSha, MIKKA_TEST_ENVIRONMENT_FILE: environmentFile,
    FIXTURE_COOKIE: cookie,
  }
  const run = args => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8', timeout: 10_000 })
  const audit = () => run([fileURLToPath(new URL('./cli.mjs', import.meta.url)), 'audit-evidence', '--evidence', evidence])
  try {
    await writeFile(environmentFile, JSON.stringify(environment), { mode: 0o600 })
    await writeFile(evidence, 'Synthetic startup failure before account acquisition\n', { mode: 0o600 })
    const missing = audit()
    assert.equal(missing.status, 1)
    assert.deepEqual(JSON.parse(missing.stderr), { status: 'blocked', code: 'SECRET_AUDIT_MISSING' })

    const initialized = run(['--input-type=module', '--eval', `
      import { recordRunnerEvidenceSecrets } from ${JSON.stringify(new URL('./bootstrap.mjs', import.meta.url).href)}
      import { loadEnvironment } from ${JSON.stringify(new URL('./environment.mjs', import.meta.url).href)}
      await recordRunnerEvidenceSecrets(await loadEnvironment())
    `])
    assert.equal(initialized.status, 0, initialized.stderr)
    assert.equal(initialized.stdout, '')
    const stateDirectory = join(root, '.cache/e2e/test-accounts', environment.instanceId)
    assert.deepEqual(await readdir(stateDirectory), ['secret-audit.jsonl'], 'runner registration does not invent account credentials or sessions')
    assert.equal((await lstat(stateDirectory)).mode & 0o077, 0)
    assert.equal((await lstat(join(stateDirectory, 'secret-audit.jsonl'))).mode & 0o077, 0)
    const clean = audit()
    assert.equal(clean.status, 0, clean.stderr)
    assert.equal(JSON.parse(clean.stdout).result, 'passed')

    const appended = run(['--input-type=module', '--eval', `
      import { recordAuthenticationSecrets } from ${JSON.stringify(new URL('./session.mjs', import.meta.url).href)}
      await recordAuthenticationSecrets([process.env.FIXTURE_COOKIE])
    `])
    assert.equal(appended.status, 0, appended.stderr)
    for (const value of [authSecret, databasePassword, encodeURIComponent(authSecret), Buffer.from(databasePassword).toString('base64'), cookie]) {
      await writeFile(evidence, `Synthetic failure includes ${value}\n`)
      const blocked = audit()
      assert.equal(blocked.status, 1)
      assert.equal(blocked.stdout, '')
      assert.deepEqual(JSON.parse(blocked.stderr), { status: 'blocked', code: 'EVIDENCE_SECRET_DETECTED' })
    }
  } finally { console.error(`Retained test fixture directory: ${root}`) }
})

test('an empty private registry cannot authorize evidence publication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-empty-evidence-registry-'))
  const stateDirectory = join(root, 'private')
  const evidence = join(root, 'startup.log')
  try {
    await mkdir(stateDirectory, { mode: 0o700 })
    await writeFile(evidence, 'Synthetic startup failure\n', { mode: 0o600 })
    await assert.rejects(auditEvidence([evidence], { environment: { instanceId: 'synthetic' }, stateDirectory }), { code: 'SECRET_AUDIT_MISSING' })
  } finally { console.error(`Retained test fixture directory: ${root}`) }
})


// These subprocesses exercise the actual account-scope implementation with
// explicit unit-only pool/environment doubles and a bounded synthetic HTTP
// transport. They do not create a deployment, database, or real test account.
async function reauthenticationUnit(scenario, moduleURL) {
  const assert = (await import('node:assert/strict')).default
  const { mock } = await import('node:test')
  const { mkdtemp, mkdir, writeFile, readFile, lstat, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { randomBytes, randomUUID } = await import('node:crypto')
  const root = await mkdtemp(join(tmpdir(), 'mikka-reauth-unit-'))
  const privateRoot = join(root, 'private')
  await mkdir(join(privateRoot, 'credentials'), { recursive: true, mode: 0o700 })
  const environment = { instanceId: randomUUID(), origin: 'http://localhost:3100', basePath: '/mikka', capabilities: { provision: false } }
  const binding = 'unit-only-binding'
  const accounts = ['owner', 'peer'].map(role => ({ role, slotId: randomUUID(), userId: randomUUID(), namespace: randomUUID(),
    email: role + '@example.test', credentialRef: randomUUID() + '.json', password: randomBytes(32).toString('base64url') }))
  for (const account of accounts) await writeFile(join(privateRoot, 'credentials', account.credentialRef),
    JSON.stringify({ binding, slotId: account.slotId, email: account.email, password: account.password }), { mode: 0o600 })
  const lease = { id: randomUUID(), pairId: randomUUID(), environmentId: environment.instanceId, generation: 1,
    state: 'active', remainingMs: 60000, accounts: accounts.map(({ password: _password, ...account }) => account) }
  const resources = [], calls = [], releases = [], sessions = new Map()
  let active = true, mode = 'initial', databaseWrites = 0
  let lastToken, lastCookie, bodyStarted, finishBody
  const bodyStartedPromise = new Promise(resolve => { bodyStarted = resolve })
  const bodyFinishPromise = new Promise(resolve => { finishBody = resolve })
  class UnitAccountError extends Error {
    constructor(code) { super(code); this.name = 'TestAccountError'; this.code = code }
  }
  class UnitPool {
    async prepare(value) { assert.deepEqual(value, { pairs: 2 }) }
    async acquire() { return lease }
    async attachSession(value) { assert.equal(value, lease) }
    async assertLease(value) { assert.equal(value, lease); if (!active) throw new UnitAccountError('LEASE_LOST') }
    async renew() { return lease }
    async recordResource(value, resource) { assert.equal(value, lease); resources.push(resource) }
    async revokeSessions() { sessions.clear() }
    async release(value, options) { assert.equal(value, lease); releases.push(options.outcome); return { state: options.outcome === 'clean' ? 'released' : 'quarantined' } }
  }
  mock.module(new URL('./environment.mjs', moduleURL).href, { namedExports: {
    assertDeploymentIdentity: async value => assert.equal(value, environment),
    environmentFingerprint: () => binding, loadEnvironment: async () => environment, validateEnvironment: value => value,
  } })
  mock.module(new URL('./pool.mjs', moduleURL).href, { namedExports: { TestAccountPool: UnitPool, TestAccountError: UnitAccountError } })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const target = new URL(url)
    assert.equal(target.origin, environment.origin)
    assert.equal(init.redirect, 'manual')
    assert.equal(init.headers.get('origin'), environment.origin)
    assert.equal(init.headers.has('authorization'), false)
    assert.equal(init.headers.has('host'), false)
    assert.ok(init.signal instanceof AbortSignal)
    const path = target.pathname
    calls.push({ path, method: init.method ?? 'GET' })
    if (path === '/mikka/api/auth/sign-in/email') {
      assert.equal(init.method, 'POST')
      const body = JSON.parse(init.body)
      assert.deepEqual(Object.keys(body).sort(), ['email', 'password'])
      const account = accounts.find(value => value.email === body.email)
      assert.ok(account && account.password === body.password)
      lastToken = randomBytes(24).toString('base64url')
      lastCookie = randomBytes(24).toString('base64url')
      const session = { user: { id: account.userId, email: account.email }, session: { id: randomUUID(), token: lastToken } }
      sessions.set(lastCookie, session)
      if (mode === 'login-rejected') return Response.json({ message: 'private-service-error' }, { status: 401 })
      const user = { ...session.user }
      if (mode === 'login-user') user.id = randomUUID()
      if (mode === 'login-email') user.email = 'different@example.test'
      const text = JSON.stringify({ user, token: lastToken })
      const headers = { 'content-type': 'application/json', 'set-cookie': 'unit.session=' + lastCookie + '; Path=/mikka; HttpOnly; SameSite=Lax' }
      if (mode === 'drain') {
        const split = Math.floor(text.length / 2)
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text.slice(0, split))); bodyStarted()
            void bodyFinishPromise.then(() => {
              controller.enqueue(new TextEncoder().encode(text.slice(split))); controller.close()
            })
          },
        }), { headers })
      }
      return new Response(text, { headers })
    }
    if (path === '/mikka/api/auth/get-session') {
      const cookie = init.headers.get('cookie')?.match(/(?:^|; )unit\.session=([^;]+)/)?.[1]
      const retained = sessions.get(cookie)
      if (!retained) return Response.json(null, { status: 401 })
      const session = structuredClone(retained)
      if (mode === 'session-user') session.user.id = randomUUID()
      if (mode === 'session-email') session.user.email = 'different@example.test'
      if (mode === 'session-id') delete session.session.id
      if (mode === 'session-rejected') return Response.json({ error: 'private-session-error' }, { status: 401 })
      return Response.json(session)
    }
    assert.ok(mode === 'initial')
    assert.ok(['/mikka/api/workspace', '/mikka/api/conversations/coordinator/read', '/mikka'].includes(path))
    return Response.json({ initialized: true })
  }
  const { acquireTestAccounts, auditEvidence } = await import(moduleURL)
  let scope, released = false, completed = false
  try {
    scope = await acquireTestAccounts({
      database: { query: async sql => { assert.ok(sql.startsWith('insert into user_onboarding')); databaseWrites++; return { rows: [] } } },
      environment, stateDirectory: privateRoot, runId: 'unit-reauth', workerId: 'unit', requestId: 'unit', ttlMs: 60000,
    })
    assert.equal(typeof scope.owner.reauthenticate, 'function')
    assert.equal(scope.owner.reauthenticate.length, 0)
    assert.equal(resources.length, 2)
    const initialStorageState = await readFile(scope.owner.storageStatePath, 'utf8')
    const startCalls = calls.length, writesBefore = databaseWrites
    if (scenario === 'success' || scenario === 'release-pending') {
      await scope.pool.revokeSessions(scope.lease)
      mode = 'drain'
      let settled = false
      const pending = scope.owner.reauthenticate().finally(() => { settled = true })
      await bodyStartedPromise
      assert.equal(settled, false)
      assert.equal(resources.length, 2, 'a partial response cannot register a completed new session')
      if (scenario === 'release-pending') {
        const reauthRejected = assert.rejects(pending, { code: 'LEASE_CLOSED' })
        const releaseRejected = assert.rejects(scope.release({ outcome: 'clean' }), { code: 'ACCOUNT_DIRTY' })
        released = true
        finishBody()
        await Promise.all([reauthRejected, releaseRejected])
        assert.deepEqual(releases, ['dirty'])
        assert.equal(resources.length, 2)
        completed = true
        return
      }
      finishBody()
      assert.equal(await pending, undefined)
      assert.deepEqual(calls.slice(startCalls), [
        { path: '/mikka/api/auth/sign-in/email', method: 'POST' },
        { path: '/mikka/api/auth/get-session', method: 'GET' },
      ])
      assert.equal(databaseWrites, writesBefore, 'reauthentication does not initialize or reseal account data')
      assert.equal(resources.length, 3)
      assert.equal(resources[2].type, 'session')
      assert.equal(resources[2].ownerId, scope.owner.userId)
      assert.ok(typeof resources[2].id === 'string' && resources[2].id !== resources[0].id)
      const refreshedStorageState = await readFile(scope.owner.storageStatePath, 'utf8')
      assert.ok(refreshedStorageState !== initialStorageState, 'normal reauthentication must refresh the existing private browser state')
      const state = JSON.parse(refreshedStorageState)
      assert.ok(state.cookies.find(cookie => cookie.name === 'unit.session')?.value === lastCookie, 'the private file must contain the newly verified session cookie')
      assert.deepEqual(state.origins, [])
      assert.equal((await lstat(scope.owner.storageStatePath)).mode & 0o777, 0o600)
      const publicShape = JSON.stringify(scope.owner)
      assert.ok(!publicShape.includes(lastToken) && !publicShape.includes(lastCookie))
      assert.ok(accounts.every(account => !publicShape.includes(account.password)))
      const journal = await readFile(join(privateRoot, 'secret-audit.jsonl'), 'utf8')
      assert.ok(journal.includes(lastToken) && journal.includes(lastCookie))
      const evidence = join(root, 'leaked.txt')
      await writeFile(evidence, lastToken)
      await assert.rejects(auditEvidence([evidence], { environment, stateDirectory: privateRoot }), { code: 'EVIDENCE_SECRET_DETECTED' })
      await scope.release({ outcome: 'clean' }); released = true
      assert.deepEqual(releases, ['clean'])
    } else if (scenario === 'arguments') {
      await assert.rejects(scope.owner.reauthenticate({ email: 'different@example.test' }), { code: 'TEST_ACCOUNT_REAUTH_ARGUMENTS_FORBIDDEN' })
      assert.equal(calls.length, startCalls)
    } else if (scenario === 'closed') {
      await scope.release({ outcome: 'clean' }); released = true
      await assert.rejects(scope.owner.reauthenticate(), { code: 'LEASE_CLOSED' })
      assert.equal(calls.length, startCalls)
    } else if (scenario === 'lost') {
      active = false
      await assert.rejects(scope.owner.reauthenticate(), { code: 'LEASE_LOST' })
      assert.equal(calls.length, startCalls)
    } else {
      mode = scenario
      const expected = scenario.startsWith('login-') && scenario !== 'login-rejected' ? 'ACCOUNT_IDENTITY_MISMATCH'
        : scenario === 'login-rejected' ? 'ACCOUNT_LOGIN_FAILED' : 'ACCOUNT_SESSION_INVALID'
      await assert.rejects(scope.owner.reauthenticate(), error => error.code === expected && error.message === expected)
      assert.equal(resources.length, 2, 'an unverified session is never registered under the leased owner')
      assert.ok(await readFile(scope.owner.storageStatePath, 'utf8') === initialStorageState, 'failed identity verification must preserve the previous private state')
      await assert.rejects(scope.release({ outcome: 'clean' }), { code: 'ACCOUNT_DIRTY' }); released = true
      assert.deepEqual(releases, ['dirty'])
    }
    completed = true
  } finally {
    if (scope && !released) await scope.release({ outcome: completed ? 'clean' : 'dirty' }).catch(() => {})
    globalThis.fetch = originalFetch
    if (completed) await rm(root, { recursive: true, force: true })
  }
}

function runReauthenticationUnit(scenario) {
  const source = '(' + reauthenticationUnit.toString() + ')('
    + JSON.stringify(scenario) + ',' + JSON.stringify(new URL('./session.mjs', import.meta.url).href) + ')'
  const child = spawnSync(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '--eval', source],
    { encoding: 'utf8', timeout: 15000, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8' } })
  assert.equal(child.status, 0, child.stderr)
}

test('reauthenticate uses the original leased identity, drains both responses, registers and audits the new private session', () => {
  runReauthenticationUnit('success')
})
test('reauthenticate rejects arguments and closed or lost leases before HTTP', () => {
  for (const scenario of ['arguments', 'closed', 'lost']) runReauthenticationUnit(scenario)
})
test('reauthenticate rejects login and session identity changes without weakening clean release', () => {
  for (const scenario of ['login-user', 'login-email', 'session-user', 'session-email', 'session-id']) runReauthenticationUnit(scenario)
})
test('reauthenticate preserves closed errors for rejected login or session responses', () => {
  for (const scenario of ['login-rejected', 'session-rejected']) runReauthenticationUnit(scenario)
})

test('reauthenticate remains in the existing pending-request guard until concurrent release has drained it', () => {
  runReauthenticationUnit('release-pending')
})
