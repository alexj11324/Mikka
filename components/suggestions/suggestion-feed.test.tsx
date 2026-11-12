import assert from 'node:assert/strict'
import { before, beforeEach, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { sendSuggestion } from '@/app/actions/coordinator'

let submit: typeof sendSuggestion
const refresh = mock.fn(async () => {})
const refreshRelated = mock.fn(async (_key: unknown) => {})
mock.module('@/app/actions/coordinator', { namedExports: { sendSuggestion: (id: string) => submit(id) } })
mock.module('@/components/coordinator/coordinator-chat', { namedExports: { coordinatorChatKey: () => ['coordinator-chat'] } })
mock.module('swr', { defaultExport: () => ({ mutate: refresh }), namedExports: { useSWRConfig: () => ({ mutate: refreshRelated }) } })
mock.module('next-intl', { namedExports: { useLocale: () => 'en', useTranslations: () => Object.assign((key: string) => key, { has: () => true }) } })

let useSuggestions: typeof import('./suggestion-feed')['useSuggestions']
let send: ReturnType<typeof useSuggestions>['send']
before(async () => { ({ useSuggestions } = await import('./suggestion-feed')) })
beforeEach(() => {
  refresh.mock.resetCalls()
  refreshRelated.mock.resetCalls()
  function Feed() { send = useSuggestions().send; return null }
  renderToStaticMarkup(<Feed />)
})

test('a dismissed or inaccessible suggestion has no delivery receipt', async () => {
  submit = async () => ({ error: 'suggestionNotFound' })
  assert.equal(await send('dismissed'), 'suggestionNotFound')
  assert.equal(refreshRelated.mock.callCount(), 0)
})

test('a committed send or matching replay stays accepted when a related read fails', async () => {
  submit = async () => ({ queued: true })
  refresh.mock.mockImplementationOnce(async () => { throw new Error('offline during readback') })
  assert.equal(await send('committed'), null)
  assert.equal(refresh.mock.callCount(), 1)
  assert.equal(refreshRelated.mock.callCount(), 3)
})

test('a malformed response cannot confirm the handoff', async () => {
  submit = async () => ({} as Awaited<ReturnType<typeof sendSuggestion>>)
  assert.equal(await send('unknown'), 'generic')
  assert.equal(refreshRelated.mock.callCount(), 0)
})

test('a lost write response stays recoverable under the same suggestion id', async () => {
  const ids: string[] = []
  submit = async id => {
    ids.push(id)
    if (ids.length === 1) throw new Error('lost response')
    return { queued: true }
  }
  assert.equal(await send('original'), 'generic')
  assert.equal(await send('original'), null)
  assert.deepEqual(ids, ['original', 'original'])
})
