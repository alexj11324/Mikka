import assert from 'node:assert/strict'
import test from 'node:test'
import type { ModelMessage } from 'ai'
import { chatItems, type ChatTool } from './context'
import { toolSummary } from './tool-activity'

type Metadata = { target?: string; displayName?: string; errorCode?: string; errorDetail?: string }
const at = new Date('2026-11-05T12:00:00Z')

function stored(name: string, input: unknown, value: unknown, outputType = 'json'): ChatTool & Metadata {
  const messages = [
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: name, input }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', toolName: name, output: { type: outputType, value } }] },
  ] as ModelMessage[]
  return chatItems(messages.map((message, index) => ({ position: index + 1, createdAt: at, message })))[0].activity!.tools[0]
}

test('a full tool result keeps its failure code after the visible output has been cut', async () => {
  const input = { taskId: 'existing-task', title: 'ALEX-45' }
  const result = { a: 'x'.repeat(350), error: 'factoryNotFound' }
  const tool = stored('get_factory_task', input, result)
  assert.equal(tool.state, 'error')
  assert.equal(tool.errorCode, 'factoryNotFound')
  assert.equal(tool.target, 'ALEX-45')
  assert.equal(tool.displayName, 'Get factory task')
  assert.equal(tool.output!.includes('factoryNotFound'), false, 'the failure does not depend on the cut preview')
  assert.deepEqual(toolSummary([tool]), { parts: [], failed: 1, failedNames: ['get_factory_task'] })

})

test('explicit failure receipts retain code and detail without treating listed item failures as the call failure', async () => {
  const rejected = { ok: false, code: 'worker_spawn_failed', detail: 'cli_not_installed', a: 'x'.repeat(300) }
  for (const tool of [stored('dispatch_run', {}, rejected)]) {
    assert.equal(tool.state, 'error')
    assert.equal(tool.errorCode, 'worker_spawn_failed')
    assert.equal(tool.errorDetail, 'cli_not_installed')
  }
  for (const output of [{ items: [{ error: 'factoryNotFound', ok: false }] }, { error: '' }, { error: null }, { error: false }, []]) {
    assert.equal(stored('list_issues', {}, output).state, 'done')
  }
  const mcp = { isError: true, structuredContent: { error: 'repositoryNotFound', detail: 'not_visible_to_token' } }
  assert.equal(stored('github_call', { name: 'pull_request_read' }, mcp).errorCode, 'repositoryNotFound')
})

test('targets and dynamic call names come from the full input rather than the preview', async () => {
  const query = 'find the latest deployment'
  const input = { a: 'padding '.repeat(80), query }
  assert.equal(stored('web_search', input, {}).target, query)
  assert.equal(stored('web_search', input, {}).input!.includes(query), false)
  for (const name of ['github_call', 'call_personal_mcp_tool']) {
    const request = { name: 'pull_request_read', arguments: { a: 'padding '.repeat(80), owner: 'alexj11324', repo: 'Mikka' } }
    const prefix = name === 'github_call' ? 'GitHub' : 'MCP'
    for (const tool of [stored(name, request, {})]) {
      assert.equal(tool.target, 'alexj11324/Mikka')
      assert.equal(tool.displayName, `${prefix} · Pull request read`)
    }
  }
})
