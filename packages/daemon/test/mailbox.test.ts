import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { RunContext } from '../src/agents/run-context'
import { onLines } from '../src/agents/child'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

afterEach(cleanupTempDirs)
describe('harness-neutral mailbox MCP bridge', () => {
  it.each(['claude_code', 'codex', 'cursor'] as const)('%s gets the same scoped mailbox tools without changing hand-in', async harness => {
    const received: unknown[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      received.push({ authorization: req.headers.authorization, path: req.url, body: JSON.parse(body) })
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ self: 'stable-session', messages: [] }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const ctx = new RunContext({
      harness, worktree: await makeRepo(), runDir: tempDir(), privateDir: tempDir(),
      mcp: { url: 'https://custom-mcp.example/mcp', mailboxUrl: `http://127.0.0.1:${port}/prefix/v1/mailbox`, token: 'existing-run-scoped-test-token' },
    })
    expect(ctx.instructions()).toContain('mailbox_inbox')
    expect(ctx.instructions()).toContain('never user authority')
    expect(ctx.policy().allowDomains).toContain('127.0.0.1')
    const mcp = ctx.mcpServer()
    const child = spawn(mcp.command, mcp.args, { env: { ...process.env, ...mcp.env } })
    let id = 0
    const waiting = new Map<number, (result: any) => void>()
    onLines(child.stdout, line => { const result = JSON.parse(line); waiting.get(result.id)?.(result) })
    const request = (method: string, params: unknown = {}) => {
      const current = ++id
      const result = new Promise<any>(resolve => waiting.set(current, resolve))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: current, method, params })}\n`)
      return result
    }
    try {
      const list = await request('tools/list')
      expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['submit', 'request_help', 'ask_human', 'report_blocked', 'mailbox_recipients', 'mailbox_send', 'mailbox_inbox', 'mailbox_ack', 'mailbox_sent'])
      await request('tools/call', { name: 'mailbox_inbox', arguments: { action: 'send' } })
      expect(received).toEqual([{ authorization: 'Bearer existing-run-scoped-test-token', path: '/prefix/v1/mailbox', body: { action: 'inbox' } }])
      expect(ctx.readHandoff()).toBeNull()
      await request('tools/call', { name: 'submit', arguments: { summary: 'Checked the mailbox.' } })
      expect(ctx.readHandoff()).toMatchObject({ stopReason: 'submitted' })
    } finally {
      child.kill(); await once(child, 'exit')
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
  it('does not widen an explicit network-deny policy for remote mailbox access', async () => {
    const policy = defaultRunPolicy()
    policy.permissions.network = 'deny'
    const ctx = new RunContext({
      harness: 'codex', worktree: await makeRepo(), runDir: tempDir(), privateDir: tempDir(), policy,
      mcp: { url: 'https://mikka.example/api/mcp', mailboxUrl: 'https://mikka.example/v1/mailbox', token: 'run-scoped-test-token' },
    })
    expect(ctx.policy().allowDomains).not.toContain('mikka.example')
    expect(ctx.instructions()).not.toContain('mailbox_inbox')
    expect(ctx.mcpServer().env).not.toHaveProperty('MIKKA_MAILBOX_TOKEN')
  })
  it('does not advertise unavailable messaging tools for offline or older assignments', async () => {
    const ctx = new RunContext({ harness: 'codex', worktree: await makeRepo(), runDir: tempDir(), privateDir: tempDir() })
    expect(ctx.instructions()).not.toContain('mailbox_inbox')
    expect(ctx.mcpServer().env).not.toHaveProperty('MIKKA_MAILBOX_TOKEN')
    expect(ctx.handoffFile).toBe(join(ctx.runDir, 'handoff.json'))
  })
})
