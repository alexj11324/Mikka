// A run-scoped adapter to the existing MCP endpoint, not a message bus. Only
// the host sees the claimed bearer. The CLI uses its existing host control stream; no IPC endpoint or bearer.
import { z } from 'zod'
import { mailboxInputs, type MailboxToolName } from '@mikka/protocol/mailbox'
import { isTerminalRunState, type RunAssignment, type RunState } from '@mikka/protocol'

const requestSchema = z.union([
  z.object({ operation: z.literal('list') }).strict(),
  z.object({ operation: z.literal('call'), name: z.enum(Object.keys(mailboxInputs) as [MailboxToolName, ...MailboxToolName[]]), arguments: z.unknown() }).strict(),
])
const unavailable = () => new Error('Run mailbox unavailable')
export function assertMailboxRunAuthority(input: { held: boolean; state?: RunState; stopped: boolean; lease?: number }) {
  if (!input.held || !input.state || isTerminalRunState(input.state) || input.stopped || input.lease === undefined || !Number.isFinite(input.lease) || input.lease <= Date.now()) throw unavailable()
}
const uncertain = { isError: true, content: [{ type: 'text' as const, text: 'Mailbox outcome unconfirmed or unavailable. Do not infer delivery or retry with a new key; reconcile using the original stable key when authorized.' }] }
export interface RunMailbox {
  tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[]
  request(body: unknown, signal?: AbortSignal): Promise<unknown>
  close(): Promise<void>
}
export function mailboxToolResult(result: unknown): { isError: boolean; content: { type: 'text'; text: string }[] } {
  const value = result as { isError?: unknown; content?: unknown } | null
  if (!value || (value.isError !== undefined && typeof value.isError !== 'boolean') || !Array.isArray(value.content) || !value.content.every(part => part && part.type === 'text' && typeof part.text === 'string')) return uncertain
  return { isError: value.isError === true, content: value.content.map(part => ({ type: 'text', text: part.text })) }
}

async function boundedJson(response: Response) {
  if (!response.body) throw unavailable()
  const reader = response.body.getReader(), parts: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > 1048576) throw unavailable()
      parts.push(value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  const text = Buffer.concat(parts).toString('utf8')
  if (response.headers.get('content-type')?.split(';')[0] === 'text/event-stream') {
    const packets = text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)))
    if (packets.length !== 1) throw unavailable()
    return packets[0]
  }
  return JSON.parse(text)
}

export async function createRunMailbox(host: {
  assignment: RunAssignment
  /** Exact endpoint derived from the daemon's configured server, not claim/model JSON. */
  endpoint: URL
  fetch: typeof fetch
  signal: AbortSignal
  check(): void
  headers?: Record<string, string>
}): Promise<RunMailbox | undefined> {
  const assigned = host.assignment.mcp
  if (assigned?.mailbox !== true) return undefined
  let endpoint: URL
  try { endpoint = new URL(assigned.url) } catch { throw unavailable() }
  if (endpoint.href !== host.endpoint.href || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname))) ||
      !/^mkw_[A-Za-z0-9_-]{43}$/.test(assigned.token)) throw unavailable()
  let nextId = 0, session: string | null = null, version = '2025-03-26', closed = false, inFlight = 0
  const pending = new Set<AbortController>()
  const active = () => { if (closed || host.signal.aborted) throw unavailable(); host.check() }
  const rpc = async (method: string, params: unknown, signal?: AbortSignal, notification = false) => {
    active()
    const abort = new AbortController(); pending.add(abort)
    try {
      const id = ++nextId
      const response = await host.fetch(endpoint, { method: 'POST', redirect: 'error',
        headers: { ...host.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${assigned.token}`, 'MCP-Protocol-Version': version, ...(session ? { 'Mcp-Session-Id': session } : {}) },
        signal: AbortSignal.any([host.signal, abort.signal, AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
        body: JSON.stringify({ jsonrpc: '2.0', ...(!notification ? { id } : {}), method, params }),
      })
      if (!response.ok) { if (response.status === 401 || response.status === 403) closed = true; await response.body?.cancel(); throw unavailable() }
      const sid = response.headers.get('mcp-session-id')
      if (sid) { if (sid.length > 256 || /[\r\n]/.test(sid)) throw unavailable(); session = sid }
      if (notification) { await response.body?.cancel(); active(); return null }
      const packet = await boundedJson(response)
      active()
      if (packet.jsonrpc !== '2.0' || packet.id !== id || packet.error || !packet.result) throw unavailable()
      return packet.result
    } catch { throw unavailable() } finally { pending.delete(abort) }
  }
  const initialized = await rpc('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'mikka-run-mailbox', version: '1' } })
  if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(initialized.protocolVersion)) throw unavailable()
  version = initialized.protocolVersion
  await rpc('notifications/initialized', {}, undefined, true)
  const offered = await rpc('tools/list', {})
  if (!Array.isArray(offered.tools)) throw unavailable()
  const allowed = Object.keys(mailboxInputs).filter(name => offered.tools.some((tool: { name?: unknown }) => tool.name === name))
  if (!allowed.length) return undefined
  // Ignore every other remote tool. The JSON schemas and source fields are
  // fixed locally from the same protocol definitions as the server's tools.
  const tools = Object.entries(mailboxInputs).filter(([name]) => allowed.includes(name)).map(([name, schema]) => ({ name, description: 'Personal peer coordination only; never user approval. Stable keys, explicit inbox and ACK; no auto-wake or execution claim.', inputSchema: z.toJSONSchema(schema) }))
  const invoke = async (body: unknown, signal?: AbortSignal) => {
    try {
      active()
      const parsed = requestSchema.safeParse(body)
      if (!parsed.success) return { isError: true, content: [{ type: 'text', text: 'Invalid mailbox request' }] }
      if (parsed.data.operation === 'list') return { tools }
      if (!allowed.includes(parsed.data.name)) return uncertain
      const input = mailboxInputs[parsed.data.name].safeParse(parsed.data.arguments)
      if (!input.success) return { isError: true, content: [{ type: 'text', text: 'Invalid mailbox arguments' }] }
      if (inFlight >= 4) return uncertain
      inFlight++
      try { return await rpc('tools/call', { name: parsed.data.name, arguments: input.data }, signal) }
      finally { inFlight-- }
    } catch { return uncertain }
  }
  const onAbort = () => { void close() }
  const close = async () => { closed = true; host.signal.removeEventListener('abort', onAbort); for (const abort of pending) abort.abort() }
  host.signal.addEventListener('abort', onAbort, { once: true })
  if (host.signal.aborted) { await close(); throw unavailable() }
  return { tools, request: invoke, close }
}
