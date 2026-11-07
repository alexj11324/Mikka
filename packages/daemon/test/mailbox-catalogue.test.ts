import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { runAssignmentSchema } from '@mikka/protocol'
import { mailboxInputs } from '@mikka/protocol/mailbox'
import { createRunMailbox } from '../src/run-mailbox'
import { createMcpHandler, withMcpAuth } from 'mcp-handler'

const endpoint = new URL('https://mikka.example/api/mcp')
const catalogue = { version: 1 as const, transport: 'mikka-stateless-2025-06-18' as const,
  tools: Object.keys(mailboxInputs) as Array<keyof typeof mailboxInputs> }
function fixture() {
  const assignment = runAssignmentSchema.parse({ runId: randomUUID(), issueId: 'i', deviceId: 'd', repoId: 'r',
    harness: 'claude_code', prompt: 'anonymous', mcp: { url: endpoint.href, token: 'mkw_' + 'x'.repeat(43), mailbox: true, mailboxCatalogue: catalogue } })
  const abort = new AbortController()
  let live = true
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const request = JSON.parse(String(init?.body))
    if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18' } })
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 })
    if (request.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: request.id, result: { tools: catalogue.tools.map(name => ({ name })) } })
    expect(request.method).toBe('tools/call')
    expect(new Headers(init?.headers).get('MCP-Protocol-Version')).toBe('2025-06-18')
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + assignment.mcp!.token)
    expect(init?.redirect).toBe('error')
    return Response.json({ jsonrpc: '2.0', id: request.id, result: { isError: true, content: [{ type: 'text', text: 'Revoked at business fence' }] } })
  })
  return { assignment, abort, transport, revoke: () => { live = false },
    create: () => createRunMailbox({ assignment, endpoint, signal: abort.signal, fetch: transport,
      check: () => { if (!live) throw Error('Run stopped') } }) }
}

it('uses claim names and local schemas without discovery, retaining the original authenticated business call and result', async () => {
  const f = fixture(), mailbox = (await f.create())!
  expect(f.transport).not.toHaveBeenCalled()
  expect(mailbox.tools.map(tool => tool.name)).toEqual(catalogue.tools)
  expect(mailbox.tools[0].inputSchema).toMatchObject({ type: 'object', additionalProperties: false })
  const result = await mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} })
  expect(result).toMatchObject({ isError: true, content: [{ text: 'Revoked at business fence' }] })
  expect(f.transport).toHaveBeenCalledTimes(1)
  f.revoke()
  expect(await mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} })).toMatchObject({ isError: true })
  expect(f.transport).toHaveBeenCalledTimes(1)
  await mailbox.close()
})

it('retains all three discovery calls with an old claim and does not infer transport support', async () => {
  const f = fixture(); delete f.assignment.mcp!.mailboxCatalogue
  const mailbox = (await f.create())!
  expect(f.transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method))
    .toEqual(['initialize', 'notifications/initialized', 'tools/list'])
  await mailbox.close()
})

it('an explicit empty catalogue disables mailbox without an HTTP request', async () => {
  const f = fixture(); f.assignment.mcp!.mailboxCatalogue!.tools = []
  expect(await f.create()).toBeUndefined()
  expect(f.transport).not.toHaveBeenCalled()
})

it.each([
  { ...catalogue, version: 2 }, { ...catalogue, transport: 'stateful' },
  { ...catalogue, tools: ['mailbox_inbox', 'mailbox_inbox'] }, { ...catalogue, tools: ['admin'] },
  { ...catalogue, token: 'foreign' }, null,
])('rejects a malformed present catalogue before discovery or business effects: %j', async bad => {
  const f = fixture()
  f.assignment.mcp!.mailboxCatalogue = bad as typeof catalogue
  expect(runAssignmentSchema.safeParse(f.assignment).success).toBe(false)
  await expect(f.create()).rejects.toThrow()
  expect(f.transport).not.toHaveBeenCalled()
})

it('checks local cancellation even when the catalogue is already available', async () => {
  const f = fixture(); f.abort.abort()
  await expect(f.create()).rejects.toThrow('unavailable')
  expect(f.transport).not.toHaveBeenCalled()
})

it('calls the installed stateless MCP transport directly while its ordinary authentication still runs on every business request', async () => {
  const f = fixture()
  let authorized = true
  const business = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Anonymous inbox' }] }))
  const authenticate = vi.fn(async (_request: Request, token?: string) =>
    authorized && token === f.assignment.mcp!.token ? { token, clientId: 'anonymous-fixture', scopes: [] } : undefined)
  const handler = withMcpAuth(createMcpHandler(server => {
    server.registerTool('mailbox_inbox', { inputSchema: mailboxInputs.mailbox_inbox }, business)
  }, { serverInfo: { name: 'fixture-stateless-mcp', version: '1' } }), authenticate, { required: true })
  const transport = vi.fn<typeof fetch>((url, init) => handler(new Request(url, init)))
  const mailbox = (await createRunMailbox({ assignment: f.assignment, endpoint, signal: f.abort.signal,
    check: () => {}, fetch: transport }))!
  expect(transport).not.toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled()
  expect(await mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} }))
    .toMatchObject({ content: [{ text: 'Anonymous inbox' }] })
  expect(authenticate).toHaveBeenCalledOnce(); expect(business).toHaveBeenCalledOnce()
  authorized = false
  expect(await mailbox.request({ operation: 'call', name: 'mailbox_inbox', arguments: {} })).toMatchObject({ isError: true })
  expect(authenticate).toHaveBeenCalledTimes(2); expect(business).toHaveBeenCalledOnce()
  expect(transport.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).method)).toEqual(['tools/call', 'tools/call'])
  await mailbox.close()
})
