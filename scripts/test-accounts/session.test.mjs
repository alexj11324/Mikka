import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, chmod, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
