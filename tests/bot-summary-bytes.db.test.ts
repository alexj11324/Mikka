import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import pg from 'pg'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// Only a disposable loopback *_e2e database is admissible; required in CI.
const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw new Error('Bot summary bytes test requires a loopback *_e2e database')

// Result JSON of every statement either pool runs while counting (as lib/db/egress-sample measures it).
let counting: { queries: number; bytes: number } | null = null
const query = pg.Client.prototype.query
pg.Client.prototype.query = function (this: pg.Client, ...args: unknown[]) {
  const tally = counting
  if (!tally) return Reflect.apply(query, this, args)
  tally.queries++
  const add = (value: { rows?: unknown[] } | undefined) => { tally.bytes += value?.rows?.length ? Buffer.byteLength(JSON.stringify(value.rows)) : 0 }
  // pg-pool passes a callback; checked-out clients use the promise.
  const callback = args.at(-1)
  if (typeof callback === 'function') return Reflect.apply(query, this, [...args.slice(0, -1), (error: unknown, value: { rows?: unknown[] }) => { if (!error) add(value); return callback(error, value) }])
  const result = Reflect.apply(query, this, args) as Promise<{ rows?: unknown[] }> | undefined
  result?.then?.(add, () => undefined)
  return result
} as typeof pg.Client.prototype.query
async function measured<T>(work: () => Promise<T>) {
  const tally = { queries: 0, bytes: 0 }
  counting = tally
  try { const value = await work(); await new Promise(resolve => setImmediate(resolve)); return { value, ...tally } }
  finally { counting = null }
}

test('the bot list reads each bot\'s preview and its citations\' names only, with the same lines as before', { skip: !enabled, timeout: 120_000 }, async t => {
  const { pool, db } = await import('../lib/db')
  const store = await import('../lib/coordinator/store')
  const { compactChatMessage } = await import('../lib/coordinator/chat-projection')
  const { chatItems } = await import('../lib/coordinator/context')
  const { namedCitations } = await import('../lib/coordinator/citations')
  const { coordinatorMessages } = await import('../lib/db/schema')
  const { and, desc, eq, isNotNull, sql } = await import('drizzle-orm')
  const { COORDINATOR_WELCOME_MARK } = await import('../lib/agent-welcome')
  const suffix = randomUUID()
  const owner = `summary-owner-${suffix}`, peer = `summary-peer-${suffix}`, stranger = `summary-stranger-${suffix}`
  const workspaceId = randomUUID(), teamId = randomUUID(), botWorkspace = randomUUID()
  const agent = randomUUID(), peerAgent = randomUUID()
  const bots: string[] = []
  const filler = (label: string) => `${label} ${'detail '.repeat(300)}`
  let number = 0
  const doc = (attrs: object = {}) => JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++number, pullRequests: [{ url: 'https://github.com/example/repo/pull/1', state: 'open', title: 'PR' }], ...attrs } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: filler('body') }] }] })
  try {
    for (const person of [owner, peer, stranger]) await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,true,now(),now())', [person, `${person}@example.invalid`])
    await pool.query('insert into mikka_workspaces(id,"userId",name) values($1,$2,$3)', [workspaceId, peer, 'Summary fixture'])
    for (const [person, role] of [[peer, 'admin'], [owner, 'member']]) await pool.query('insert into mikka_workspace_members("workspaceId","userId",name,email,role) values($1,$2,$2,$3,$4)', [workspaceId, person, `${person}@example.invalid`, role])
    await pool.query('insert into mikka_teams(id,"workspaceId","userId",name,identifier) values($1,$2,$3,$4,$5)', [teamId, workspaceId, peer, 'Summary team', 'SUM'])
    await pool.query('insert into agents(id,"userId",name,harness) values($1,$2,$3,$4),($5,$6,$7,$8)', [agent, owner, 'Owner agent', 'codex', peerAgent, peer, 'Peer agent', 'claude_code'])
    await seedFixtureWorkspace(pool, owner, 'personal', botWorkspace)
    const issue = async (userId: string, scope: string, attrs: object = {}) => {
      const id = randomUUID()
      await pool.query('insert into issues(id,"userId",title,content,status,priority,scope,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,$8,\'bound\')', [id, userId, `Task ${id.slice(0, 4)}`, doc(attrs), 'doing', 'normal', scope, scope === 'workspace' ? workspaceId : await seedFixtureWorkspace(pool, userId)])
      return id
    }
    const own = await issue(owner, 'personal'), deleted = await issue(owner, 'personal', { deletedAt: new Date().toISOString() })
    const foreign = await issue(stranger, 'personal'), shared = await issue(peer, 'workspace')
    await pool.query('insert into mikka_team_issues("issueId","teamId","workspaceId","userId") values($1,$2,$3,$4)', [shared, teamId, workspaceId, peer])
    // Prompts whose name comes from a later line, a cut first line, a list marker line, a rule, CJK and digits.
    const prompts = [`\n\n  ## **Fix** the login bug that drops a session when the token refresh races the logout\n${filler('prompt')}`,
      `\`\`\`\nconst session = refresh()\n\`\`\`\n${filler('prompt')}`, `1. **\n**Real** name after an empty list item\n${filler('prompt')}`,
      `---\nAfter a rule\n${filler('prompt')}`, `${'短'.repeat(700)}\n${filler('prompt')}`, `12345\n\nWords after digits\n${filler('prompt')}`, '   ']
    const runs: string[] = []
    for (const [index, prompt] of prompts.entries()) {
      const id = randomUUID(); runs.push(id)
      await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt,report,error,"workspaceId") values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, owner, index % 2 ? own : null, agent, 'succeeded', prompt, JSON.stringify({ summary: filler('summary'), files: filler('files') }), filler('error'), botWorkspace])
    }
    const teammateRun = randomUUID(), strangerRun = randomUUID()
    await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt) values($1,$2,$3,$4,$5,$6)', [teammateRun, peer, shared, peerAgent, 'running', filler('Private teammate prompt')])
    await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt) values($1,$2,$3,$4,$5,$6)', [strangerRun, stranger, foreign, peerAgent, 'running', filler('Stranger prompt')])
    const cite = (kind: 'run' | 'issue', id: string) => `[[${kind}:${id}]]`
    const toolCall = { type: 'tool-call', toolCallId: 'call-1', toolName: 'dispatch_run', input: { note: filler('note'), repo: 'example/repo' } }
    const latest: object[] = [
      { role: 'assistant', content: [{ type: 'reasoning', text: filler('thinking') }, toolCall, { type: 'text', text: `Started ${cite('run', runs[0])} for ${cite('issue', own)}` }, toolCall] },
      { role: 'assistant', content: [{ type: 'reasoning', text: filler('thinking') }] },
      { role: 'assistant', content: [toolCall] },
      { role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: 'x'.repeat(4000) }] },
      { role: 'user', content: [{ type: 'text', text: `[Event] A thread finished\nTriage: hidden\n${filler('event')}` }] },
      { role: 'assistant', content: [{ type: 'text', text: runs.slice(1).map(id => cite('run', id)).join(' · ') + ` ${cite('run', teammateRun)} ${cite('run', strangerRun)} ${cite('issue', deleted)} ${cite('issue', foreign)} ${cite('issue', shared)}` }] },
      { role: 'assistant', content: 'A plain string reply' },
      { role: 'user', content: `[Event] Shared [[artifact:${randomUUID()}]]\n${filler('artifact event')}` },
      { role: 'user', content: [{ type: 'text', text: `[Event] typed by a person\n${filler('person')}` }], mikkaUserEvent: true },
      { role: 'user', content: [{ type: 'text', text: '[Event] split' }, { type: 'text', text: filler('second part') }], mikkaUserEvent: 0 },
      { role: 'user', content: [{ type: 'text', text: `${COORDINATOR_WELCOME_MARK} hello` }], mikkaFailure: 'provider_unavailable' },
      { role: 'assistant', content: [{ type: 'text', text: '```openui\nCard(title: "Status", body: "' + filler('card') + '")\n```\nAfter the card' }], mikkaStopped: true },
    ]
    for (const [index, message] of latest.entries()) {
      const bot = randomUUID(); bots.push(bot)
      await pool.query('insert into bots(id,"ownerId","workspaceId",name) values($1,$2,$3,$4)', [bot, owner, botWorkspace, `Bot ${index}`])
      await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,1,$4)', [randomUUID(), owner, bot, JSON.stringify({ role: 'user', content: 'earlier' })])
      await pool.query('insert into coordinator_messages(id,"userId","botId",position,message) values($1,$2,$3,2,$4)', [randomUUID(), owner, bot, JSON.stringify(message)])
    }

    // The previous read: whole compact messages and full citation sources.
    const before = await measured(async () => {
      const rows = await db.selectDistinctOn([coordinatorMessages.botId], { botId: coordinatorMessages.botId, message: compactChatMessage, createdAt: coordinatorMessages.createdAt })
        .from(coordinatorMessages).where(and(eq(coordinatorMessages.userId, owner), isNotNull(coordinatorMessages.botId), sql`${coordinatorMessages.message}->>'role' <> 'tool'`))
        .orderBy(coordinatorMessages.botId, desc(coordinatorMessages.position))
      const lines = rows.flatMap(row => {
        const [item] = chatItems([{ position: 0, message: row.message as never, createdAt: row.createdAt }])
        if (item?.welcome) return []
        return [{ botId: row.botId!, text: item?.from === 'event' ? null : item?.text || null, from: item?.from, at: row.createdAt.toISOString() }]
      })
      const sources = await store.citationSources(owner, lines.flatMap(line => line.from === 'coordinator' && line.text ? [line.text] : []))
      return Object.fromEntries(lines.map(line => [line.botId, { line: (line.text && line.from === 'coordinator' ? namedCitations(line.text, sources) : line.text) || null, at: line.at }]))
    })
    const after = await measured(() => store.botChatSnapshot(owner))
    const lines = Object.fromEntries(Object.entries(after.value.items).map(([bot, item]) => [bot, { line: item.line, at: item.at }]))
    assert.deepEqual(lines, before.value, 'every bot\'s preview line and time are the same')
    // The fixture exercises names from later lines, teammates and hidden or deleted tasks.
    assert.match(lines[bots[0]].line ?? '', /^Started Fix the login bug that drops a session when the token refre… for Task /)
    assert.equal(lines[bots[5]].line, `const session = refresh() · Real name after an empty list item · --- · ${'短'.repeat(59)}… · 12345 · Owner agent claude_code    Task ${shared.slice(0, 4)}`)
    const welcome = latest.findIndex(message => JSON.stringify(message).includes(COORDINATOR_WELCOME_MARK))
    assert.equal(after.value.items[bots[welcome]], undefined, 'a failed welcome has no preview')
    assert.ok(after.bytes < before.bytes / 5, JSON.stringify({ before: before.bytes, after: after.bytes }))
    t.diagnostic(JSON.stringify({ bots: bots.length, citedRuns: runs.length + 2, beforeJsonBytes: before.bytes, afterJsonBytes: after.bytes, beforeQueries: before.queries, afterQueries: after.queries }))
  } finally {
    await pool.query('delete from coordinator_messages where "userId"=$1', [owner])
    await pool.query('delete from bots where "ownerId"=$1', [owner])
    await pool.query('delete from agent_runs where "userId"=any($1::text[])', [[owner, peer, stranger]])
    await pool.query('delete from agents where id=any($1::uuid[])', [[agent, peerAgent]])
    await pool.query('delete from mikka_team_issues where "teamId"=$1', [teamId])
    await pool.query('delete from issues where "userId"=any($1::text[])', [[owner, peer, stranger]])
    await pool.query('delete from mikka_teams where id=$1', [teamId])
    await pool.query('delete from mikka_workspace_members where "workspaceId"=$1', [workspaceId])
    await pool.query('delete from mikka_workspaces where id=$1', [workspaceId])
    await pool.query('delete from mikka_workspace_members where "userId"=any($1::text[])', [[owner, peer, stranger]])
    await pool.query('delete from mikka_workspaces where "userId"=any($1::text[])', [[owner, peer, stranger]])
    await pool.query('delete from "user" where id=any($1::text[])', [[owner, peer, stranger]])
  }
})
