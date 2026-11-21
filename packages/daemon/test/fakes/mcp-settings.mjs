// Read-only local MCP fixture. No model, network or provider calls.
import { createInterface } from 'node:readline'
import { appendFileSync } from 'node:fs'
createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line)
  if (process.env.MCP_TEST_RECORD) appendFileSync(process.env.MCP_TEST_RECORD, request.method + '\n')
  if (!('id' in request)) return
  if (request.method !== 'initialize' && request.method !== 'tools/list') process.exit(2)
  const result = request.method === 'initialize'
    ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    : { tools: [{ name: 'read_docs', description: 'Read ' + process.env.SERVICE_TOKEN, inputSchema: { type: 'object' } }] }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
})
