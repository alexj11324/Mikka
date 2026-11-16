// Switching workspace keeps the old one and says why when it does not take (usability review #7).
import assert from 'node:assert/strict'
import { after, mock, test } from 'node:test'
import { act, createElement } from 'react'
import { Window } from 'happy-dom'
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

const browser = new Window({ url: 'https://fixture.example' })
Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
after(() => browser.happyDOM.close())

let accountId = '1'
const initial = Promise.withResolvers<string>()
const nextAccount = Promise.withResolvers<string>()
const writes: string[] = []
mock.module('react-native', { namedExports: { Platform: { OS: 'ios' } } })
mock.module('expo-secure-store', { namedExports: {
  getItemAsync: () => accountId === '1' ? initial.promise : nextAccount.promise,
  setItemAsync: async (_key: string, value: string) => { writes.push(value) },
} })
mock.module(new URL('../lib/config.ts', import.meta.url).href, { namedExports: { currentAccount: () => ({ id: accountId }) } })

const { createRoot } = await import('react-dom/client')
const { useWorkspaceOrder } = await import('../features/workspace/model/use-workspace-order.ts')

test('finishing the initial device read preserves an order the user has already changed', async () => {
  const root = createRoot(document.body)
  let reorder!: (ids: string[]) => void
  function Picker() {
    const [ids, save] = useWorkspaceOrder()
    reorder = save
    return createElement('output', null, ids.join(','))
  }
  try {
    await act(async () => root.render(createElement(Picker)))
    await act(async () => reorder(['b', 'a']))
    assert.deepEqual(writes, ['["b","a"]'])
    await act(async () => initial.resolve('["a","b"]'))
    assert.equal(document.body.textContent, 'b,a')
    accountId = '2'
    await act(async () => root.render(createElement(Picker)))
    assert.equal(document.body.textContent, '')
    await act(async () => nextAccount.resolve('["z","y"]'))
    assert.equal(document.body.textContent, 'z,y')
  } finally {
    await act(async () => root.unmount())
  }
})
