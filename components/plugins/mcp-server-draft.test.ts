import assert from 'node:assert/strict'
import test from 'node:test'
import { mcpServerInput, type McpServerDraft } from './mcp-server-draft'

const draft = (overrides: Partial<McpServerDraft> = {}): McpServerDraft => ({
  name: 'Internal docs', transport: 'http', url: 'https://docs.example.test/mcp',
  command: '', arguments: '', cwd: '', values: [], ...overrides,
})

test('a remote MCP header is sent literally, without shell expansion or trimming the token', () => {
  const result = JSON.parse(JSON.stringify(mcpServerInput(draft({ values: [
    { name: 'Authorization', value: 'Bearer $TOKEN=abc==' },
    { name: 'X-Workspace', value: ' sandbox ' },
  ] }))))
  assert.deepEqual(result, { name: 'Internal docs', transport: 'http', enabled: true,
    url: 'https://docs.example.test/mcp', headers: { Authorization: 'Bearer $TOKEN=abc==', 'X-Workspace': ' sandbox ' } })
})

test('STDIO configuration preserves spaces within arguments and multiline credential values', () => {
  const result = JSON.parse(JSON.stringify(mcpServerInput(draft({ transport: 'stdio',
    command: 'npx', arguments: '-y\r\n@example/docs-mcp\r\n/path with spaces', cwd: '/workspace/repo',
    values: [{ name: 'SERVICE_KEY', value: 'line-one\nline-two' }],
  }))))
  assert.deepEqual(result, { name: 'Internal docs', transport: 'stdio', enabled: true,
    command: 'npx', args: ['-y', '@example/docs-mcp', '/path with spaces'], cwd: '/workspace/repo',
    env: { SERVICE_KEY: 'line-one\nline-two' } })
  assert.equal('url' in result, false)
  assert.equal('headers' in result, false)
})

test('a local command needs neither environment entries nor arguments', () => {
  assert.deepEqual(mcpServerInput(draft({ transport: 'stdio', command: 'docs-mcp' })), {
    name: 'Internal docs', enabled: true, transport: 'stdio', command: 'docs-mcp', args: [],
  })
})

test('duplicate or incomplete credentials are rejected without echoing their values', () => {
  for (const values of [
    [{ name: 'Authorization', value: 'sensitive-one' }, { name: 'authorization', value: 'sensitive-two' }],
    [{ name: '', value: 'sensitive-value' }],
    [{ name: 'Authorization', value: '' }],
  ]) assert.throws(() => mcpServerInput(draft({ values })), /^Error: invalidMcpVariables$/)
  assert.throws(() => mcpServerInput(draft({ transport: 'stdio', command: 'npx', values: [{ name: 'INVALID-NAME', value: 'sensitive' }] })), /^Error: invalidMcpVariables$/)
})
