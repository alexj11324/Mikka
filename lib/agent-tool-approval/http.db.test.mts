import { after, before, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { Pool } from 'pg'

const url = process.env.APPROVAL_TEST_DATABASE_URL
if (!url) throw new Error('isolated database required')
const target = new URL(url)
if (!['localhost','127.0.0.1','[::1]'].includes(target.hostname) || target.pathname !== '/approval_e2e') throw new Error('Refusing non-isolated database')
const pool = new Pool({ connectionString: url }); const runId = randomUUID(), deviceId = randomUUID(), agentId = randomUUID()
const owner = `synthetic-${randomUUID()}`
mock.module(new URL('../db/index.ts', import.meta.url).href, { namedExports: { pool } })
mock.module(new URL('../device-link.ts', import.meta.url).href, { namedExports: { authenticateDevice: async (request: Request) => request.headers.get('authorization') === 'Bearer synthetic' ? { userId: owner } : null } })
mock.module(new URL('../auth.ts', import.meta.url).href, { namedExports: { auth: { api: { getSession: async ({ headers }: { headers: Headers }) => ({ user: { id: headers.get('cookie') === 'owner=1' ? owner : 'other' } }) } } } })
let server: Server, origin: string, dir: string
before(async () => {
  await pool.query(`INSERT INTO agents VALUES ($1,$2,'codex')`, [agentId,owner])
  await pool.query(`INSERT INTO devices VALUES ($1,$2,true)`, [deviceId,owner])
  await pool.query(`INSERT INTO agent_runs VALUES ($1,$2,$3,'running',NULL,now()+interval '5 minutes',$4,NULL)`, [runId,owner,deviceId,agentId])
  const device = await import('../../app/v1/runs/[runId]/tool-approval/route')
  const browser = await import('../../app/api/agent-tool-approvals/route')
  server = createServer(async (req,res) => {
    try {
      const chunks: Buffer[]=[]; for await (const part of req) chunks.push(Buffer.from(part))
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers: req.headers as HeadersInit, body: Buffer.concat(chunks) })
      const response = req.url === '/api/agent-tool-approvals' ? await browser.POST(request) : await device.POST(request, { params: Promise.resolve({ runId }) })
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(500).end() }
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  dir = await mkdtemp(resolve(tmpdir(), 'pr13-approval-'))
  execFileSync('git', ['init', '-q', dir])
})
after(async () => { await new Promise<void>(r => server.close(() => r())); await rm(dir,{recursive:true,force:true}); await pool.end() })
test('real HTTP routes carry a pending CLI request to owner approval and one response', async () => {
  const { HttpServerLink } = await import('../../packages/daemon/src/server-link-http')
  const { CodexAdapter } = await import('../../packages/daemon/src/adapters/codex')
  const { NoSandbox } = await import('../../packages/daemon/src/agents/sandbox')
  const { createLogger } = await import('../../packages/daemon/src/log')
  const link = new HttpServerLink(origin)
  Object.assign(link, { credential: 'synthetic' })
  const assignment = { runId, issueId: 'issue', deviceId, repoId: 'repo', baseBranch: 'main', harness: 'codex' as const, prompt: 'APPROVAL_TEST' }
  const gate = await link.prepareRunToolApproval(assignment, new AbortController().signal, () => {})
  const adapter = new CodexAdapter({ sandbox: new NoSandbox(), stateDir: dir, userHome: dir, binary: resolve('packages/daemon/test/fakes/fake-codex.mjs') })
  const session = await adapter.start({ runId, cwd: dir, prompt: assignment.prompt, env: { PATH: process.env.PATH ?? '' }, log: createLogger(), toolApproval: gate })
  const browser = async (cookie: string, payload: object) => fetch(`${origin}/api/agent-tool-approvals`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
  let request: { id:string; digest:string } | undefined
  for (let n=0; n<50 && !request; n++) { const response=await browser('owner=1',{ operation:'list',runId }); const body=await response.json() as {requests: Array<{id:string;digest:string}>}; request=body.requests[0]; if (!request) await new Promise(r=>setTimeout(r,50)) }
  assert.ok(request)
  assert.equal((await browser('other=1',{ operation:'decide',runId,id:request.id,digest:request.digest,decision:'approve' })).status,409)
  assert.equal((await browser('owner=1',{ operation:'decide',runId,id:request.id,digest:request.digest,decision:'approve' })).status,200)
  let output=''; for await (const event of session.events()) if (event.type === 'chunk' && event.chunk.type === 'text-delta') output+=event.chunk.delta
  const result=JSON.parse(output); assert.equal(result.first.decision,'accept'); assert.equal(result.replay.decision,'decline'); assert.equal(result.foreign.decision,'decline')
})
