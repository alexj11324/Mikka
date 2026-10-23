import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { Window } from 'happy-dom'
import { createElement, useLayoutEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'

const window = new Window({ url: 'http://localhost/mikka/en' })
function expose(key, value) {
  try { globalThis[key] = value } catch { Object.defineProperty(globalThis, key, { value, configurable: true }) }
}
expose('window', window)
expose('document', window.document)
expose('navigator', window.navigator)
expose('HTMLElement', window.HTMLElement)
expose('Element', window.Element)
expose('Node', window.Node)
expose('DocumentFragment', window.DocumentFragment)
expose('MutationObserver', window.MutationObserver)
expose('getComputedStyle', window.getComputedStyle.bind(window))
expose('requestAnimationFrame', window.requestAnimationFrame.bind(window))
expose('cancelAnimationFrame', window.cancelAnimationFrame.bind(window))
expose('HTMLInputElement', window.HTMLInputElement)
expose('HTMLButtonElement', window.HTMLButtonElement)
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const { Select } = await import('@base-ui/react/select')
const selectRoot = realpathSync(new URL('../node_modules/@base-ui/react/select/root/SelectRoot.mjs', import.meta.url))
const storeUrl = pathToFileURL(realpathSync(join(dirname(selectRoot), '../../../../@base-ui/utils/store/Store.mjs'))).href
const { Store } = await import(storeUrl)
const { useTeamChoices } = await import('../components/teams/team-choices.ts')

const teams = [{ id: 't1', identifier: 'ORV', name: 'Core' }]

function selectTree(items, nonce) {
  return createElement('div', null,
    String(nonce),
    createElement(Select.Root, { value: 'none', items },
      createElement(Select.Trigger, null, createElement(Select.Value, null)),
      createElement(Select.Portal, null,
        createElement(Select.Positioner, null,
          createElement(Select.Popup, null,
            createElement(Select.Item, { value: 'none' }, 'No team'),
          ),
        ),
      ),
    ),
  )
}

function MemoTeamSelect({ nonce }) {
  const items = useTeamChoices(teams, 'No team')
  return selectTree(items, nonce)
}

function InlineTeamSelect({ nonce }) {
  const items = [{ value: 'none', label: 'No team' }, ...teams.map(team => ({ value: team.id, label: `${team.identifier} · ${team.name}` }))]
  return selectTree(items, nonce)
}

function Harness({ View }) {
  const [nonce, setNonce] = useState(0)
  useLayoutEffect(() => { if (nonce < 5) setNonce(value => value + 1) }, [nonce])
  return createElement(View, { nonce })
}

async function countItemWrites(View) {
  let writes = 0
  const original = Store.prototype.update
  Store.prototype.update = function count(changes) {
    if (changes && Object.prototype.hasOwnProperty.call(changes, 'items') && !Object.is(this.state.items, changes.items)) writes += 1
    return original.call(this, changes)
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => { root.render(createElement(Harness, { View })) })
    return writes
  } finally {
    await act(async () => { root.unmount() })
    host.remove()
    Store.prototype.update = original
  }
}

test('re-rendering the team control with equal props does not update Select items', async () => {
  const writes = await countItemWrites(MemoTeamSelect)
  // The store is seeded with the memoized array, so later renders must not write `items` again.
  assert.equal(writes, 0)
})

test('a fresh team items array is written into the Select store on every render', async () => {
  const writes = await countItemWrites(InlineTeamSelect)
  assert.ok(writes > 1, `expected the inline items array to be stored more than once, got ${writes}`)
})
