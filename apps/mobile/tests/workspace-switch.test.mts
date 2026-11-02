// Switching workspace keeps the old one and says why when it does not take (usability review #7).
import assert from 'node:assert/strict'
import test from 'node:test'
import { switchWorkspace } from '../lib/workspace-switch.ts'

const target = { id: 'acme', name: 'Acme 团队' }

test('a switch the server takes shows nothing', async () => {
  const saved: string[] = []
  assert.equal(await switchWorkspace(target, 'mikka', { save: async id => { saved.push(id) }, current: async () => 'acme' }), null)
  assert.deepEqual(saved, ['acme'])
})

test('a workspace the server does not take goes back to the old one', async () => {
  const saved: string[] = []
  assert.equal(await switchWorkspace(target, 'mikka', { save: async id => { saved.push(id) }, current: async () => 'mikka' }), '没切到 Acme 团队：你不在这个工作区')
  assert.deepEqual(saved, ['acme', 'mikka'])
})

test('no connection goes back to the old one', async () => {
  const saved: string[] = []
  assert.equal(await switchWorkspace(target, 'mikka', { save: async id => { saved.push(id) }, current: async () => { throw new Error('timeout') } }), '没切到 Acme 团队：连不上 Mikka')
  assert.deepEqual(saved, ['acme', 'mikka'])
})
