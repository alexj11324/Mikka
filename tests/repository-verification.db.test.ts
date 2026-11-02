import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { remoteKey } from '@mikka/protocol/repository'
import { dbUrl } from './support/workspace-admin-db'

test('verification saves and clears preserve repository policy and isolate the owner and remote key', { skip: !dbUrl }, async t => {
  const [{ pool }, { saveRepositoryVerifyCommand, readRepositorySettings }] = await Promise.all([import('../lib/db'), import('../lib/device-repositories')])
  const owner = `repo-verification-${randomUUID()}`, peer = `repo-verification-peer-${randomUUID()}`
  const remote = 'https://github.com/Acme/Repo.git', key = remoteKey(remote)
  const push = { approved: true, remote: 'origin', approvedByUserId: owner, approvedAt: new Date().toISOString() }
  const setup = { version: 1, steps: ['pnpm install'] }, networkAllow = ['registry.npmjs.org']
  t.after(async () => { await pool.query('DELETE FROM repository_settings WHERE "userId" = ANY($1)', [[owner, peer]]); await pool.end() })
  await pool.query('INSERT INTO repository_settings ("userId","remoteKey","verifyCommand",push,setup,"networkAllow","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7)', [owner, key, 'old command', push, setup, JSON.stringify(networkAllow), new Date('2020-01-01')])
  await saveRepositoryVerifyCommand(peer, remote, 'peer command')
  await saveRepositoryVerifyCommand(owner, 'https://github.com/acme/other.git', 'other command')
  for (const command of ['pnpm check', null]) {
    await saveRepositoryVerifyCommand(owner, 'git@github.com:acme/repo.git', command)
    const saved = await readRepositorySettings(owner, remote)
    assert.ok(saved)
    assert.equal(saved.remoteKey, key)
    assert.equal(saved.verifyCommand, command)
    assert.deepEqual(saved.push, push)
    assert.deepEqual(saved.setup, setup)
    assert.deepEqual(saved.networkAllow, networkAllow)
    assert.ok(saved.updatedAt > new Date('2020-01-01'))
    assert.equal((await readRepositorySettings(peer, remote))?.verifyCommand, 'peer command')
    assert.equal((await readRepositorySettings(owner, 'https://github.com/acme/other.git'))?.verifyCommand, 'other command')
  }
  assert.equal(await readRepositorySettings(owner, 'https://github.com/acme/unset.git'), null)
  await saveRepositoryVerifyCommand(owner, 'https://github.com/acme/unset.git', null)
  assert.equal((await readRepositorySettings(owner, 'https://github.com/acme/unset.git'))?.verifyCommand, null)
})
