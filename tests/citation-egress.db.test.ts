import { seedFixtureWorkspace } from './helpers/task-workspace'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

const enabled = disposableDatabase()
if (process.env.REQUIRE_DB === '1' && !enabled) throw Error('Citation egress requires a disposable loopback *_e2e database')
const sockets = new Set<Socket>(), original = Socket.prototype.connect
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  sockets.add(this); return Reflect.apply(original, this, args)
} as typeof Socket.prototype.connect
const received = () => [...sockets].reduce((sum, socket) => sum + socket.bytesRead, 0)

test('a chat\'s cited runs show the same name, summary and task without reading whole prompts, reports or bodies', { skip: !enabled }, async t => {
  const { pool } = await import('../lib/db')
  const { citationSources } = await import('../lib/coordinator/store')
  const { visibleRuns } = await import('../lib/agent-runs')
  const { issueForUser } = await import('../lib/issue-access')
  const { threadName } = await import('../lib/issue-threads')
  const { runSummaryText } = await import('../lib/issue-run-conversation')
  const { readIssueMetadata } = await import('../lib/issue-metadata')
  const owner = `citation-egress-${randomUUID()}`
  const agent = randomUUID(), issueId = randomUUID()
  const filler = 'x'.repeat(60_000)
  const pullRequests = [{ url: 'https://github.com/example/repo/pull/7', state: 'open', title: 'Fix login' }]
  const body = { type: 'doc', attrs: { mikka: { number: 12, pullRequests } }, content: Array.from({ length: 40 }, (_, line) => ({ type: 'paragraph', content: [{ type: 'text', text: `Line ${line} ${'words '.repeat(400)}` }] })) }
  // Leading blank lines, markdown marks, a fenced opening, a long first line in CJK: the name comes from the first line.
  const prompts = [
    `\n\n  ## **Fix** the login bug that drops a session when the token refresh races the logout\n${filler}`,
    `   \n\t\n${'短'.repeat(700)}\n${filler}`,
    `\`\`\`\nconst session = refresh()\n\`\`\`\n${filler}`,
    `Short prompt`,
  ]
  const reports = [{ summary: '  Fixed the race.  ', files: filler }, { notes: filler }, null, ['not', 'an', 'object']]
  const errors = [null, `\n  Token expired\n${filler}`, 'Build failed', null]
  const runs = prompts.map(() => randomUUID())
  try {
    await pool.query('insert into "user"(id,name,email,"emailVerified","createdAt","updatedAt") values($1,$1,$2,false,now(),now())', [owner, `${owner}@example.invalid`])
    await pool.query('insert into agents(id,"userId",name,harness) values($1,$2,$3,$4)', [agent, owner, 'Fixture bot', 'codex'])
    await pool.query('insert into issues(id,"userId",title,content,status,priority,"workspaceId","ownershipState") values($1,$2,$3,$4,$5,$6,$7,\'bound\')', [issueId, owner, 'Login task', JSON.stringify(body), 'doing', 'normal', await seedFixtureWorkspace(pool, owner)])
    const workspaceId = await seedFixtureWorkspace(pool, owner)
    const identity = { requester: owner, executionPrincipal: owner, outputOwner: owner, workspaceId, notes: filler }
    for (const [index, id] of runs.entries()) {
      await pool.query('insert into agent_runs(id,"userId","issueId","agentId",status,prompt,report,error,"agentDefinition","workspaceId") values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        // The task's newest thread (index 2) waits on the person; the older ones it cites succeeded.
        [id, owner, index === 3 ? null : issueId, agent, index === 2 ? 'waiting_input' : 'succeeded', prompts[index], reports[index] === null ? null : JSON.stringify(reports[index]), errors[index], JSON.stringify({ harness: 'codex', executionIdentity: identity }), workspaceId])
    }
    const full = new Map((await visibleRuns(owner, { runIds: runs, limit: runs.length })).map(run => [run.id, run]))
    const task = await issueForUser(owner, issueId)
    assert.ok(task)

    const before = received()
    const sources = await citationSources(owner, [runs.map(id => `[[run:${id}]]`).join(' ')])
    const bytes = received() - before

    for (const [index, id] of runs.entries()) {
      const source = sources[id]
      assert.ok(source?.kind === 'run', `run ${index} is cited`)
      const run = full.get(id)!
      assert.equal(source.name, threadName(prompts[index], run.agentName), `run ${index}: the same name as from its whole prompt`)
      assert.equal(source.summary, runSummaryText(run), `run ${index}: the same summary as from its whole report`)
      // Every cited run's task carries the task's newest thread, so its card names the task's current state, not this run's.
      assert.deepEqual(source.issue, index === 3 ? null : { id: issueId, title: task.title, number: 12, identifier: source.issue?.identifier ?? null, status: 'doing', run: { status: 'waiting_input', outcome: null } })
      assert.deepEqual(source.pullRequests, index === 3 ? [] : readIssueMetadata(task.content).pullRequests)
    }
    assert.equal((sources[runs[0]] as { name: string }).name, 'Fix the login bug that drops a session when the token refre…')
    assert.equal((sources[runs[0]] as { summary: string }).summary, 'Fixed the race.')

    // A cited task carries its newest thread's status and outcome and its PRs, for its one state (localTaskState).
    const cited = (await citationSources(owner, [`[[issue:${issueId}]]`]))[issueId]
    assert.ok(cited?.kind === 'issue')
    assert.deepEqual(cited.run, { status: 'waiting_input', outcome: null }, 'the newest of its threads')
    assert.deepEqual(cited.pullRequests, readIssueMetadata(task.content).pullRequests)

    // The list projection: only the report's summary, no provenance.
    const brief = await visibleRuns(owner, { runIds: runs, limit: runs.length, brief: true })
    assert.deepEqual(brief.find(run => run.id === runs[0])?.report, { summary: '  Fixed the race.  ' })
    assert.equal(brief.find(run => run.id === runs[2])?.report, null)
    assert.equal(brief.some(run => 'executionIdentity' in run || 'agentProfile' in run), false)

    const stored = (await pool.query('select sum(length(prompt))::int + sum(coalesce(length(report::text), 0))::int + sum(length("agentDefinition"::text))::int as n from agent_runs where "userId"=$1', [owner])).rows[0].n as number
    t.diagnostic(JSON.stringify({ storedRunBytes: stored, bodyBytes: JSON.stringify(body).length, citationDbBytes: bytes }))
    // Whole prompts, reports and the task body would be at least `stored` + the body's size.
    assert.ok(bytes < stored / 10, `citationSources read ${bytes} B for ${stored} B of run text`)
  } finally {
    await pool.query('delete from agent_runs where "userId"=$1', [owner])
    await pool.query('delete from agents where id=$1', [agent])
    await pool.query('delete from issues where id=$1', [issueId])
    await pool.query('delete from mikka_workspace_members where "userId"=$1', [owner])
    await pool.query('delete from mikka_workspaces where "userId"=$1', [owner])
    await pool.query('delete from "user" where id=$1', [owner])
    await pool.end()
  }
})
