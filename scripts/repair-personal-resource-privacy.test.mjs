import assert from 'node:assert/strict'
import test from 'node:test'
import { repairCommand, repairPersonalResourcePrivacy } from './repair-personal-resource-privacy.mjs'

const workspace = '00000000-0000-4000-8000-000000000001'
const env = { MIKKA_DATABASE_URL: 'postgresql://fixture@db.example.invalid:5433/app', DATABASE_URL: 'postgresql://fixture@ws.example.invalid/workspace?sslmode=require' }
const selection = ['--apply', '--workspace', workspace, '--actor', 'operator', '--app-target', 'db.example.invalid:5433/app', '--workspace-target', 'ws.example.invalid:5432/workspace']

test('repair is a dry-run by default even with remote configured targets', () => {
  assert.deepEqual(repairCommand([], env).options, { dryRun: true, workspaceIds: [], actorId: undefined })
  assert.equal(repairCommand(selection, env).options.dryRun, false)
})

test('apply rejects unbounded Workspaces and wrong/ambiguous database targets before connecting', async () => {
  for (const args of [['--apply'], selection.slice(0, -2), selection.map(arg => arg === 'db.example.invalid:5433/app' ? 'db.example.invalid:5433/wrong' : arg), ['--workspace', 'invalid']]) {
    assert.throws(() => repairCommand(args, env))
  }
  assert.throws(() => repairCommand(selection, { ...env, MIKKA_DATABASE_URL: env.MIKKA_DATABASE_URL + '?host=other.example.invalid' }))
  await assert.rejects(repairPersonalResourcePrivacy(null, null, { dryRun: false, actorId: 'operator' }))
  await assert.rejects(repairPersonalResourcePrivacy(null, null, { dryRun: false, workspaceIds: [workspace] }))
})
