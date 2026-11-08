// A real SDK MCP server with a one-shot late binding. Blocking handlers stay
// in an owned process group, outside the daemon/SDK event loop.
import { fork, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod'
import { mikkaMcpToolCatalogue, type MikkaMcpAuthority, type MikkaMcpContext, type MikkaMcpProfile, type MikkaMcpResponse } from './mikka-mcp-backend.mjs'
import { stopGroup } from '../process-group'

const worker = fileURLToPath(new URL('./mikka-mcp-worker.mjs', import.meta.url))
const list = z.object({ method: z.literal('tools/list'), params: z.object({ cursor: z.string().optional() }).passthrough().optional() })
const call = z.object({ method: z.literal('tools/call'), params: z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).passthrough() })

export function prepareMikkaMcpBridge(profile: MikkaMcpProfile) {
  const frozenProfile = structuredClone(profile)
  const tools = mikkaMcpToolCatalogue(frozenProfile)
  const server = createSdkMcpServer({ name: 'mikka', version: '1' })
  let consumed = false, bound = false, closed = false, nextId = 0
  let child: ChildProcess | undefined, exited: Promise<void> | undefined, closing: Promise<void> | undefined
  let authority: MikkaMcpAuthority | undefined
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  const unavailable = () => Error('Mikka MCP binding unavailable')
  const assertLive = () => {
    if (!bound || closed || !authority) throw unavailable()
    authority.signal.throwIfAborted()
    authority.assertLive()
  }
  const abort = () => { void close().catch(() => undefined) }
  const close = (): Promise<void> => {
    if (closing) return closing
    closed = true; bound = false
    for (const request of pending.values()) request.reject(unavailable())
    pending.clear()
    // Publish before signals/process callbacks can re-enter close.
    closing = Promise.resolve().then(async () => {
      try { if (child) await stopGroup(child); await exited }
      finally { authority?.signal.removeEventListener('abort', abort) }
    })
    return closing
  }
  const request = (operation: string, payload: Record<string, unknown>) => new Promise<unknown>((resolve, reject) => {
    if (closed || !child?.connected) { reject(unavailable()); return }
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.send({ id, operation, ...payload }, error => {
      if (error) { pending.delete(id); reject(unavailable()); abort() }
    })
  })
  server.instance.server.registerCapabilities({ tools: {} })
  server.instance.server.setRequestHandler(list, async () => ({ tools: structuredClone(tools) }))
  server.instance.server.setRequestHandler(call, async message => {
    assertLive()
    const result = await request('call', { request: { jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: message.params } }) as MikkaMcpResponse
    assertLive()
    if (result.error || !result.result) throw unavailable()
    return result.result
  })
  return {
    server,
    tools: () => structuredClone(tools),
    get bound() { return bound },
    async bind(context: MikkaMcpContext, gate: MikkaMcpAuthority) {
      if (consumed || closed) throw unavailable()
      consumed = true
      authority = gate
      try {
        gate.signal.throwIfAborted(); gate.assertLive()
        child = fork(worker, [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          // Node runtime only; task secrets/context cross the private bind IPC.
          env: { PATH: process.env.PATH, HOME: process.env.HOME }, execArgv: [] })
        exited = new Promise<void>(resolve => { child!.once('close', () => { resolve(); abort() }); child!.once('error', () => { resolve(); abort() }) })
        child.on('message', value => {
          if (!value || typeof value !== 'object' || !('id' in value) || typeof value.id !== 'number') return
          const receipt = value as { id: number; error?: unknown; result?: unknown }
          const waiting = pending.get(receipt.id)
          if (!waiting) return
          pending.delete(receipt.id)
          if (receipt.error) waiting.reject(unavailable()); else waiting.resolve(receipt.result)
        })
        gate.signal.addEventListener('abort', abort, { once: true })
        if (gate.signal.aborted) abort()
        await request('bind', { profile: frozenProfile, context })
        gate.signal.throwIfAborted(); gate.assertLive()
        if (closed) throw unavailable()
        bound = true
      } catch (cause) { await close(); throw new Error('Mikka MCP binding unavailable', { cause }) }
    },
    close,
  }
}
