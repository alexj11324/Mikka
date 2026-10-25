import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import type { Pool } from 'pg'
import { SessionMailbox, MailboxError } from '../lib/session-mailbox'
import { verifiedWorkerToken } from '../lib/run-token-auth'

/** Real shipped MCP stdio process and PostgreSQL. HTTP harness uses the store;
 * it is not a claim of Next auth/issue-policy or provider acceptance. */
export async function retryMcpAcceptance(pool: Pool, store: SessionMailbox, fixture: {
  owner: string; issue: string; role: string; device: string; repo: string; to: string;
}) {
  const { owner, issue, role, device, repo, to } = fixture
  async function run(parent: string | null = null) {
    const id = randomUUID(), token = `mkw_${randomUUID()}`
    await pool.query(`insert into agent_runs (id,"userId","issueId","agentId","deviceId","deviceRepoId",status,"retryOf",attempt)
      values ($1,$2,$3,$4,$5,$6,'running',$7,$8)`, [id,owner,issue,role,device,repo,parent,parent ? 2 : 1])
    await pool.query(`insert into run_tokens (id,"runId","userId","tokenHash","expiresAt") values ($1,$2,$3,$4,now()+interval '1 hour')`, [randomUUID(),id,owner,createHash('sha256').update(token).digest('hex')])
    return { id, token }
  }
  const first = await run()
  let dropNext = true
  const server = createServer(async (request, response) => {
    try {
      const token = request.headers.authorization?.slice(7)
      const auth = await verifiedWorkerToken(pool, token)
      if (!auth) { response.writeHead(401).end('{}'); return }
      let body = ''; for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      assert.equal(input.action, 'send')
      const actor = await store.run(auth.userId, auth.runId)
      const result = await store.send(actor, input)
      if (dropNext) { dropNext = false; response.destroy(); return }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result))
    } catch (error) {
      response.writeHead(error instanceof MailboxError ? error.status : 500)
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'error' }))
    }
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  function worker(token: string) {
    const child = spawn(process.execPath, ['packages/daemon/src/agents/mikka-mcp.mjs', '--handoff', `/tmp/mikka-retry-handoff-${randomUUID()}.json`], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH, MIKKA_MAILBOX_URL: `http://127.0.0.1:${port}/v1/mailbox`, MIKKA_MAILBOX_TOKEN: token },
      stdio: ['pipe','pipe','pipe'],
    })
    let sequence = 0
    const replies = new Map<number, (result: { result: { isError: boolean; content: { text: string }[] } }) => void>()
    createInterface({ input: child.stdout }).on('line', line => { const value = JSON.parse(line); replies.get(value.id)?.(value) })
    return {
      async send(input: { to: string; key: string; text: string }) {
        const id = ++sequence
        const result = new Promise<{ result: { isError: boolean; content: { text: string }[] } }>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('MCP response timeout')), 20000)
          replies.set(id, value => { clearTimeout(timer); replies.delete(id); resolve(value) })
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'mailbox_send', arguments: input } })}\n`)
        return (await result).result
      },
      async stop() { if (child.exitCode !== null || child.signalCode !== null) return; const closed = once(child, 'close'); child.kill(); await closed },
    }
  }
  const children: ReturnType<typeof worker>[] = []
  try {
    const original = worker(first.token); children.push(original)
    const input = { to, key: randomUUID(), text: 'MCP commit followed by socket loss' }
    assert.equal((await original.send(input)).isError, true)
    const saved = (await pool.query('select id from run_messages where "dedupeKey"=$1', [input.key])).rows
    assert.equal(saved.length, 1)
    // Crash/restart the MCP process after the lost receipt; persist run retry.
    await original.stop(); children.pop()
    await pool.query(`update agent_runs set status='failed',"stopReason"='device_lost' where id=$1`, [first.id])
    const retry = await run(first.id), resumed = worker(retry.token); children.push(resumed)
    for (let i=0; i<3; i++) {
      const replay = await resumed.send(input)
      assert.equal(replay.isError, false)
      const receipt = JSON.parse(replay.content[0].text)
      assert.equal(receipt.id, saved[0].id); assert.equal(receipt.duplicate, true)
    }
    const old = worker(first.token); children.push(old)
    assert.equal((await old.send(input)).isError, true)
    const other = await run(), independent = worker(other.token); children.push(independent)
    assert.equal((await independent.send(input)).isError, false)
    assert.equal((await pool.query('select count(*) from run_messages where "dedupeKey"=$1', [input.key])).rows[0].count, '2')
    assert.equal((await resumed.send({ ...input, text: 'changed intent' })).isError, true)
    await pool.query('update run_tokens set "revokedAt"=now() where "runId"=$1', [retry.id])
    assert.equal((await resumed.send({ ...input, key: randomUUID() })).isError, true)
  } finally {
    for (const child of children) await child.stop()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
}
