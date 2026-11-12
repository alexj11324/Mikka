import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import { Window } from 'happy-dom'

const successes: string[] = []
const errors: string[] = []
const writes: unknown[] = []
let receipt: 'queued' | 'not_possible' = 'not_possible'
let denied = false
mock.module(new URL('../../app/actions/agents.ts', import.meta.url).href, { namedExports: {
  removeDevice: async (id: string) => { writes.push(id); return { id, uninstall: receipt } },
  setDeviceEnabled: async (value: unknown) => { writes.push(value); return denied ? { error: 'deviceNotFound' } : { success: true } },
  renameDevice: async (id: string, name: string) => { writes.push({ id, name }); return { id, name } },
  sendDeviceCommand: async (value: unknown) => { writes.push(value); return { id: 'command' } },
} })
mock.module('sonner', { namedExports: { toast: { success: (v: string) => successes.push(v), error: (v: string) => errors.push(v) } } })
mock.module('next-intl', { namedExports: { useTranslations: () => Object.assign((key: string) => key, { has: () => true }) } })

const browser = new Window()
let createRoot: typeof import('react-dom/client')['createRoot']
let useDeviceActions: typeof import('./use-device-actions')['useDeviceActions']
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useDeviceActions } = await import('./use-device-actions'))
})
after(() => browser.happyDOM.close())

test('device commands use the selected id and the removal receipt, and refresh only after a successful write', async () => {
  const root = createRoot(document.body)
  let actions!: ReturnType<typeof useDeviceActions>
  let changed = 0
  function Row({ online }: { online: boolean }) {
    actions = useDeviceActions({ id: 'desktop', name: 'Desktop', online }, () => { changed++ })
    return null
  }
  try {
    await act(async () => root.render(<Row online />))
    await act(async () => {
      assert.deepEqual(await Promise.all([actions.remove(), actions.remove()]), [true, false])
    })
    assert.deepEqual(successes, [], 'a stale online snapshot must not announce an uninstall')
    assert.equal(changed, 1)
    await act(async () => root.render(<Row online={false} />))
    receipt = 'queued'
    await act(async () => {
      await actions.remove()
      await actions.command('redetect')
      await actions.rename('  Kitchen  ')
      await actions.setEnabled(false)
      denied = true
      assert.equal(await actions.setEnabled(true), false)
    })
    assert.equal(changed, 5)
    assert.deepEqual(writes, ['desktop', 'desktop', { deviceId: 'desktop', kind: 'redetect' }, { id: 'desktop', name: 'Kitchen' },
      { deviceId: 'desktop', enabled: false }, { deviceId: 'desktop', enabled: true }])
    assert.deepEqual(successes, ['remove.uninstalling', 'commands.queued'])
    assert.deepEqual(errors, ['deviceNotFound'])
  } finally {
    await act(async () => root.unmount())
  }
})
