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
