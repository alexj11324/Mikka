import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { test, expect } from '@playwright/test'
import { Client, ClientError } from 'eve/client'
import { acquireTestAccounts } from '../../scripts/test-accounts/session.mjs'
import { loadEnvironment } from '../../scripts/test-accounts/environment.mjs'
import { assertMvpEnvironment } from './isolated-env.mjs'

// Keep the enrolled local MVP path; all requests use native Eve, with no UI or model turn.
assertMvpEnvironment()

test('native Eve creates and replays one scoped session without granting another owner or Bot access', async () => {
  const testInfo = test.info()
  const environment = await loadEnvironment()
  const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 2 })
  const accounts = await acquireTestAccounts({
    database: pool, environment, runId: `eve-mvp-${randomUUID()}`,
    workerId: `eve-http-${testInfo.workerIndex}`, requestId: randomUUID(),
  }).catch(async error => { await pool.end(); throw error })
  try {
    const workspace = async (ownerId: string) => {
      const result = await pool.query<{ id: string }>('SELECT id FROM mikka_workspaces WHERE "userId"=$1 ORDER BY "createdAt" LIMIT 1', [ownerId])
      expect(result.rowCount).toBe(1)
      return result.rows[0].id
    }
    const ownerId = accounts.owner.userId, peerId = accounts.peer.userId
    const ownerWorkspace = await workspace(ownerId), peerWorkspace = await workspace(peerId)
    const ownerBot = randomUUID(), otherBot = randomUUID(), peerBot = randomUUID()
    for (const [id, owner, workspaceId] of [[ownerBot, ownerId, ownerWorkspace], [otherBot, ownerId, ownerWorkspace], [peerBot, peerId, peerWorkspace]]) {
      await pool.query('INSERT INTO bots(id,"ownerId","workspaceId",name) VALUES($1,$2,$3,\'Native Eve HTTP fixture\')', [id, owner, workspaceId])
    }
    const client = async (account: typeof accounts.owner, botId: string) => {
      const state = JSON.parse(await readFile(account.storageStatePath, 'utf8')) as { cookies: { name: string; value: string; domain: string }[] }
      const host = new URL(environment.origin).hostname
      expect(state.cookies.every(cookie => cookie.domain === host)).toBe(true)
      // Authentication stays in memory; native Client owns all session routes and event decoding.
      const cookie = state.cookies.map(item => `${item.name}=${item.value}`).join('; ')
      return new Client({ baseUrl: `${environment.origin}${environment.basePath}/api/agents?botId=${botId}`,
        headers: async () => { await accounts.assertActive(); return { cookie, origin: environment.origin } },
      })
    }
    const owner = await client(accounts.owner, ownerBot)
    const first = (await owner.sessions.create()).session
    expect((await owner.sessions.create()).session.id).toBe(first.id)
    const initial = await first.snapshot({ signal: AbortSignal.timeout(15_000) })
    const replay = await first.snapshot({ signal: AbortSignal.timeout(15_000) })
    expect(replay.session.streamIndex).toBeGreaterThanOrEqual(initial.session.streamIndex)
    expect(replay.events.slice(0, initial.events.length)).toEqual(initial.events)
    expect(replay.events.some(event => event.type === 'turn.started' || event.type === 'model.requested')).toBe(false)
    const forbidden = async (target: Client, sessionId: string) => {
      let status = 0
      try { await target.sessions.attach(sessionId).snapshot({ signal: AbortSignal.timeout(15_000) }) }
      catch (error) { status = ClientError.is(error) ? error.status : 0 }
      expect(status).toBe(404)
    }
    await forbidden(await client(accounts.owner, otherBot), first.id)
    await forbidden(await client(accounts.peer, peerBot), first.id)
    await forbidden(owner, `wrun_${randomUUID()}`)
    const mapping = await pool.query('SELECT owner_id,bot_id,workspace_id,surface FROM eve_sessions WHERE session_id=$1', [first.id])
    expect(mapping.rows).toEqual([{ owner_id: ownerId, bot_id: ownerBot, workspace_id: ownerWorkspace, surface: 'web' }])
    expect((await pool.query('SELECT 1 FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=$2', [ownerId, ownerBot])).rowCount).toBe(0)
    await testInfo.attach('native-eve-http', { contentType: 'application/json', body: JSON.stringify({
      revision: environment.deploymentSha, sessionId: first.id, botId: ownerBot,
      workspaceId: ownerWorkspace, replayCursor: replay.session.streamIndex, modelTurns: 0,
    }) })
  } finally {
    // Native sessions and their Bot fixtures are retained; this pair cannot be reused.
    try {
      const retained = await accounts.release({ outcome: 'dirty' })
      expect(retained.state).toBe('quarantined')
    } finally { await pool.end() }
  }
})
