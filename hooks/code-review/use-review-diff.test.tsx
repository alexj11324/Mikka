import assert from 'node:assert/strict'
import { after, before, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'

let revision = 'first'
let failure = false
const reads: string[] = []
mock.module('@/hooks/use-live-key', { namedExports: { useLiveKeys: () => {} } })
mock.module('@/lib/code-review/client', { namedExports: {
  getReviewChecks: () => [], getReviewFile: () => null,
  getReviewDiff: async (_id: string, options: { cursor?: string }) => {
    reads.push(options.cursor ?? 'root')
    if (failure) throw new Error('review_unavailable')
    return {
      summary: { live: { workspaceId: 'workspace' } },
      diff: { files: [{ path: options.cursor ?? revision }], nextCursor: options.cursor ? undefined : 'additional' },
    }
  },
} })

const browser = new Window({ url: 'https://fixture.example/' })
let root: Root
let useReviewDiff: typeof import('./use-review-diff')['useReviewDiff']
let state: ReturnType<typeof useReviewDiff>
const paths = () => state.files.map(file => file.path)
function Probe() { state = useReviewDiff('task'); return null }
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = await import('react-dom/client')
  ;({ useReviewDiff } = await import('./use-review-diff'))
  root = createRoot(document.body)
})
after(async () => { await act(async () => root.unmount()); await browser.happyDOM.close() })

test('a refused current Review withdraws its summary, diff and loaded file pages until a successful retry', async () => {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}><Probe /></SWRConfig>))
  assert.deepEqual(paths(), ['first'])
  failure = true
  await act(async () => { await state.loadMore() })
  assert.equal(state.loadMoreError, true)
  assert.deepEqual(paths(), ['first'])
  assert.equal(state.nextCursor, 'additional')
  failure = false
  await act(async () => { await state.loadMore() })
  assert.deepEqual(paths(), ['first', 'additional'])
  assert.equal(state.loadMoreError, false)

  failure = true
  await act(async () => { await state.mutate() })
  assert.ok(state.error)
  assert.equal(state.data, undefined)
  assert.deepEqual(paths(), [])
  assert.equal(state.nextCursor, undefined)
  await act(async () => { await state.loadMore() })
  assert.deepEqual(reads, ['root', 'additional', 'additional', 'root'])

  failure = false
  revision = 'replacement'
  await act(async () => { await state.mutate() })
  assert.equal(state.error, undefined)
  assert.deepEqual(paths(), ['replacement'])
  assert.equal(state.nextCursor, 'additional')
})
