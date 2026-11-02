import assert from 'node:assert/strict'
import { mock, test } from 'node:test'
import * as Y from 'yjs'

type Call = { update?: string; known?: string }
const calls: Call[] = []
let answer: (call: Call) => { update?: string; version: string }
mock.module('@/app/actions/collaboration', { namedExports: { exchangeDocument: async (input: Call) => { calls.push(input); return answer(input) } } })
const load = () => import('./document-sync')

const seed = (() => {
  const doc = new Y.Doc()
  doc.getXmlFragment('default').insert(0, [new Y.XmlText('Seed')])
  return Y.encodeStateAsUpdate(doc)
})()

test('a poll with no local edits sends the version it holds, not the document', async () => {
  const { DocumentSync } = await load()
  const sync = new DocumentSync('issue-1', seed)
  answer = () => ({ update: Buffer.from(seed).toString('base64'), version: 'a'.repeat(32) })
  await sync.exchange()
  assert.equal(calls.at(-1)?.update, undefined, 'the first exchange seeds; it has nothing to upload')

  answer = () => ({ version: 'a'.repeat(32) })
  await sync.exchange()
  assert.equal(calls.at(-1)?.update, undefined)
  assert.equal(calls.at(-1)?.known, 'a'.repeat(32))
  assert.deepEqual(sync.getSnapshot(), { ready: true, pending: false, error: false, syncing: false })

  // A local edit uploads the whole state and drops the version until the server answers.
  sync.doc.getXmlFragment('default').insert(0, [new Y.XmlText('Edit')])
  answer = () => ({ update: '', version: 'b'.repeat(32) })
  await sync.exchange()
  assert.ok(calls.at(-1)?.update)
  assert.equal(calls.at(-1)?.known, undefined)
  assert.equal(sync.getSnapshot().pending, false)

  answer = () => ({ version: 'b'.repeat(32) })
  await sync.exchange()
  assert.equal(calls.at(-1)?.update, undefined)
  assert.equal(calls.at(-1)?.known, 'b'.repeat(32))
  sync.destroy()
})
