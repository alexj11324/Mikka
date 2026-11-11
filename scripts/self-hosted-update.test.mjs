import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assessUpgrade, assertPinnedImage, ensureRegularEnvFile, migrationsFingerprint,
  parseStableRelease, releaseFromWebhook, STABLE_TAG, verifySignature
} from './self-hosted-update-policy.mjs'
import { replaceImage } from './self-hosted-update.mjs'

const previous = '1'.repeat(40)
const next = '2'.repeat(40)
const before = 'a'.repeat(64)
const after = 'b'.repeat(64)
const marker = '<!-- mikka-self-hosted-release-v1 sha=' + next + ' migrations=' + after + ' protocol=0-1 -->'
const release = { tag_name: 'v1.2.3', draft: false, prerelease: false, body: marker }

test('only explicit stable semver with trusted release metadata activates an image', () => {
  const target = parseStableRelease(release)
  assert.deepEqual(target, { tag: 'v1.2.3', revision: next, migrations: after, image: 'ghcr.io/alexj11324/mikka:v1.2.3' })
  for (const tag of ['latest', 'main', 'v1.2.3-rc.1', 'v01.2.3', 'desktop-2026.1.1', 'v1.2.3;touch /tmp/unsafe', 'v1.2']) {
    assert.equal(STABLE_TAG.test(tag), false)
    assert.throws(() => parseStableRelease({ ...release, tag_name: tag }), /SELF_HOSTED_UPDATE_RELEASE_NOT_STABLE/)
  }
  assert.throws(() => parseStableRelease({ ...release, body: '' }), /RELEASE_UNVERIFIED/)
  assert.throws(() => parseStableRelease({ ...release, prerelease: true }), /RELEASE_NOT_STABLE/)
  assert.throws(() => parseStableRelease({ ...release, draft: true }), /RELEASE_NOT_STABLE/)
})

test('webhook requires raw-body HMAC and exact repository, action, and release type', () => {
  const secret = 'a-stable-upgrade-secret-that-is-at-least-32-bytes'
  const payload = { repository: { full_name: 'alexj11324/Mikka' }, action: 'published', release }
  const sign = bytes => 'sha256=' + createHmac('sha256', secret).update(bytes).digest('hex')
  const bytes = Buffer.from(JSON.stringify(payload))
  const headers = { 'x-github-event': 'release', 'x-hub-signature-256': sign(bytes) }
  assert.equal(verifySignature(bytes, headers['x-hub-signature-256'], secret), true)
  assert.equal(verifySignature(bytes, 'sha256=' + '0'.repeat(64), secret), false)
  assert.equal(verifySignature(bytes, 'SHA256=' + '0'.repeat(64), secret), false)
  assert.deepEqual(releaseFromWebhook(bytes, headers, secret).tag, 'v1.2.3')
  assert.throws(() => releaseFromWebhook(Buffer.from('x'), headers, secret), /WEBHOOK_UNAUTHORIZED/)
  assert.equal(releaseFromWebhook(bytes, { ...headers, 'x-github-event': 'push' }, secret), null)
  for (const patch of [
    { repository: { full_name: 'attacker/Mikka' } }, { action: 'deleted' },
    { release: { ...release, tag_name: 'v1.2.3-rc.1' } }
  ]) {
    const altered = Buffer.from(JSON.stringify({ ...payload, ...patch }))
    assert.equal(releaseFromWebhook(altered, { ...headers, 'x-hub-signature-256': sign(altered) }, secret), null)
  }
})

test('agent activity, schema differences, and backup proof fail closed on unattended upgrades', () => {
  const current = { revision: previous, migrations: before }
  const target = { revision: next, migrations: before }
  assert.deepEqual(assessUpgrade(current, target, { unattended: true, idleGuard: true, drainHook: true }), {
    action: 'upgrade', migrationChanged: false
  })
  assert.throws(() => assessUpgrade(current, target, { unattended: true, idleGuard: true }), /DRAIN_REQUIRED/)
  assert.throws(() => assessUpgrade(current, { ...target, migrations: after }, { unattended: true, idleGuard: true, drainHook: true }), /MIGRATION_REVIEW_REQUIRED/)
  assert.throws(() => assessUpgrade(current, { ...target, migrations: after }, { allowMigrations: true }), /BACKUP_REQUIRED/)
  assert.deepEqual(assessUpgrade(current, { ...target, migrations: after }, { allowMigrations: true, backupHook: true }), {
    action: 'upgrade', migrationChanged: true
  })
  assert.equal(assessUpgrade({ revision: next, migrations: after }, { ...target, migrations: after }).action, 'already-current')
  assert.throws(() => assessUpgrade({ revision: 'unknown', migrations: before }, target), /INSTALLED_REVISION_UNKNOWN/)
})

test('image inputs stay immutable; dotenv rewrite is not command or shell interpolation', () => {
  assert.equal(assertPinnedImage('ghcr.io/alexj11324/mikka@sha256:' + after), 'ghcr.io/alexj11324/mikka@sha256:' + after)
  for (const bad of ['ghcr.io/alexj11324/mikka:latest', 'ghcr.io/attacker/mikka@sha256:' + after, 'sha256:' + after]) {
    assert.throws(() => assertPinnedImage(bad), /IMAGE_NOT_PINNED/)
  }
  const text = 'POSTGRES_PASSWORD=secret\nMIKKA_IMAGE=old\nBETTER_AUTH_URL=http://localhost:3000\n'
  assert.equal(replaceImage(text, 'new'), text.replace('MIKKA_IMAGE=old', 'MIKKA_IMAGE=new'))
  assert.match(replaceImage('X=1\n', 'new'), /\nMIKKA_IMAGE=new\n$/)
  assert.throws(() => replaceImage('MIKKA_IMAGE=1\nMIKKA_IMAGE=2\n', 'new'), /DUPLICATE_IMAGE_VAR/)
})

test('migration inventory changes when a SQL or metadata file changes', () => {
  const temp = mkdtempSync(join(tmpdir(), 'mikka-update-'))
  try {
    const dir = join(temp, 'drizzle')
    mkdirSync(join(dir, 'meta'), { recursive: true })
    writeFileSync(join(dir, '0001.sql'), 'CREATE TABLE example(id integer);\n')
    const first = migrationsFingerprint(dir)
    assert.match(first, /^[a-f0-9]{64}$/)
    assert.equal(migrationsFingerprint(dir), first)
    writeFileSync(join(dir, 'meta', 'journal.json'), '{"entries":[]}\n')
    assert.notEqual(migrationsFingerprint(dir), first)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('operator dotenv files must not be symlinks or non-regular targets', () => {
  const root = mkdtempSync(join(tmpdir(), 'mikka-updater-env-'))
  try {
    const real = join(root, 'real')
    writeFileSync(real, 'TEST=1\n')
    assert.doesNotThrow(() => ensureRegularEnvFile(real))
    const linked = join(root, 'linked')
    symlinkSync(real, linked)
    assert.throws(() => ensureRegularEnvFile(linked), /ENV_NOT_REGULAR/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
