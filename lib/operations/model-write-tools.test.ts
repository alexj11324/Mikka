import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { modelWriteTools, type ModelWriteCall } from './model-write-tools'

const catalog = [{ name: 'write_document', description: 'Write to the selected document', inputSchema: z.object({ target: z.string(), text: z.string() }).strict() }]
const execute = (tools: ReturnType<typeof modelWriteTools>, input: unknown, toolCallId = 'call-1') => (tools.write_document.execute as unknown as (input: unknown, options: { toolCallId: string; messages: [] }) => Promise<unknown>)(input, { toolCallId, messages: [] })

test('model selects content, host receives call identity and chooses authorization', async () => {
  const calls: ModelWriteCall[] = []
  const tools = modelWriteTools(true, catalog, async call => { calls.push(call); return { status: 'pending' } })
  assert.deepEqual(await execute(tools, { target: 'doc', text: 'hello' }), { status: 'pending' })
  assert.deepEqual(calls, [{ action: 'write_document', input: { target: 'doc', text: 'hello' }, toolCallId: 'call-1' }])
  await assert.rejects(execute(tools, { target: 'doc', text: 'hello', allowed: true }))
  await assert.rejects(execute(tools, { target: 'doc', text: 'hello' }, ''))
  assert.equal(calls.length, 1)
})

test('disabled catalog exposes nothing and invalid or duplicate names fail closed', () => {
  assert.deepEqual(modelWriteTools(false, catalog, async () => null), {})
  assert.throws(() => modelWriteTools(true, [...catalog, ...catalog], async () => null), /invalidWriteToolCatalog/)
  assert.throws(() => modelWriteTools(true, [{ ...catalog[0], name: '__proto__' }], async () => null), /invalidWriteToolCatalog/)
})
