import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMcpHandler } from 'mcp-handler'
import { RECORD_DECISION_TOOL, RUN_DECISION_CATALOGUE } from './mcp-tool'

test('claim catalogue exactly matches the real installed MCP tools/list serialization', async () => {
  const handler = createMcpHandler(server => {
    server.registerTool('record_decision', RECORD_DECISION_TOOL, async () => ({ content: [] }))
  }, { serverInfo: { name: 'decision-catalogue-test', version: '1' } })
  const response = await handler(new Request('http://localhost/api/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  }))
  assert.equal(response.status, 200)
  const text = await response.text()
  const envelope = text.trim().startsWith('{') ? JSON.parse(text)
    : JSON.parse(text.split('\n').find(line => line.startsWith('data: '))!.slice(6))
  assert.deepEqual(envelope.result.tools, [RUN_DECISION_CATALOGUE.tool])
  assert.ok(Buffer.byteLength(JSON.stringify(RUN_DECISION_CATALOGUE)) <= 32_768)
  assert.equal(RUN_DECISION_CATALOGUE.tool.inputSchema.additionalProperties, false)
  assert.ok((RUN_DECISION_CATALOGUE.tool.inputSchema.required as string[]).includes('idempotencyKey'))
  // These refinements remain enforced by the actual tool's original Zod
  // schema; supplying the static JSON catalogue does not replace validation.
  assert.equal(RECORD_DECISION_TOOL.inputSchema.safeParse({ kind: 'choose', title: 'Choice', summary: 'Choice',
    reason: 'Reason', idempotencyKey: 'test', options: [], selectedOptionId: null }).success, false)
})
