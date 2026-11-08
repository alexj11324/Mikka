import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { disposableDatabase } from './helpers/e2e-target.mjs'

// No business/local database fallback, including when REQUIRE_DB is unset.
const url = process.env.E2E_DATABASE_URL
const authorized = disposableDatabase()
if (url && !authorized) throw new Error('Visibility DB tests require a loopback *_e2e database')
if (process.env.REQUIRE_DB === '1' && !authorized) throw new Error('Visibility database tests cannot skip in required CI')

test('reading only the asked-about tasks\' team links gives exactly the full read\'s visibility', { skip: !authorized }, async () => {
  const { Pool } = await import('pg')
  const pool = new Pool({ connectionString: url, max: 2 })
  const { and, inArray } = await import('drizzle-orm')
  const { db } = await import('../lib/db')
  const { issues } = await import('../lib/db/schema')
  const { issueVisibility } = await import('../lib/issue-visibility')
  const { issueTeamScope } = await import('../lib/issue-team-access')
  const { issueForUser } = await import('../lib/issue-access')
  const { issuesForUser } = await import('../lib/issues-for-user')
  const { tokenWorkspace } = await import('../lib/tokens/principal')
  const { enterprisePrincipal } = await import('../lib/enterprise/principal')
  const { visibleRuns } = await import('../lib/agent-runs')
  const { citationSources } = await import('../lib/coordinator/store')

  const tag = randomUUID().slice(0, 8)
  const owner = `narrow-owner-${tag}`, member = `narrow-member-${tag}`, removed = `narrow-removed-${tag}`, foreign = `narrow-foreign-${tag}`
  const users = [owner, member, removed, foreign]
  const workspace = randomUUID(), otherWorkspace = randomUUID(), ownerPersonal = randomUUID(), memberPersonal = randomUUID()
  const team = randomUUID(), secondTeam = randomUUID(), foreignTeam = randomUUID()
  const issue = { shared: randomUUID(), secondTeam: randomUUID(), personal: randomUUID(), unlinked: randomUUID(), foreign: randomUUID(), ownPersonal: randomUUID() }
  const agent = randomUUID()
  const runs: Record<string, string> = {}
  let number = 0
  const doc = () => JSON.stringify({ type: 'doc', attrs: { mikka: { number: ++number } }, content: [] })
  try {
    for (const id of users) await pool.query('insert into "user" (id,name,email,"emailVerified","createdAt","updatedAt") values ($1,$1,$2,true,now(),now())', [id, `${id}@example.invalid`])
    for (const [id, user, kind] of [[workspace, owner, 'team'], [otherWorkspace, foreign, 'team'], [ownerPersonal, owner, 'personal'], [memberPersonal, member, 'personal']]) await pool.query('insert into mikka_workspaces (id,"userId",name,kind) values ($1,$2,$3,$4)', [id, user, `Narrow ${id}`,kind])
    for (const [w, u, status] of [[workspace, owner, 'active'], [workspace, member, 'active'], [workspace, removed, 'active'], [otherWorkspace, foreign, 'active'],[ownerPersonal,owner,'active'],[memberPersonal,member,'active']]) {
      await pool.query('insert into mikka_workspace_members ("workspaceId","userId",name,email,role,status) values ($1,$2,$2,$3,\'member\',$4)', [w, u, `${u}@example.invalid`, status])
    }
    for (const [id, w, u] of [[team, workspace, owner], [secondTeam, workspace, owner], [foreignTeam, otherWorkspace, foreign]]) {
      await pool.query('insert into mikka_teams (id,"workspaceId","userId",name,identifier) values ($1,$2,$3,\'Narrow\',$4)', [id, w, u, `N${id.slice(0, 3).toUpperCase()}`])
    }
    const issueRows: [string, string, string, string][] = [
      [issue.shared, owner, 'workspace',workspace], [issue.secondTeam, owner, 'workspace',workspace], [issue.personal, owner, 'personal',ownerPersonal],
      [issue.unlinked, owner, 'workspace',workspace], [issue.foreign, foreign, 'workspace',otherWorkspace], [issue.ownPersonal, member, 'personal',memberPersonal],
    ]
    for (const [id, u, scope, tenant] of issueRows) await pool.query('insert into issues (id,"userId",title,content,status,priority,scope,"workspaceId") values ($1,$2,$5,$3,\'doing\',\'normal\',$4,$6)', [id, u, doc(), scope, id,tenant])
    for (const [id, t, w, u] of [[issue.shared, team, workspace, owner], [issue.secondTeam, secondTeam, workspace, owner], [issue.personal, team, workspace, owner], [issue.foreign, foreignTeam, otherWorkspace, foreign]]) {
      await pool.query('insert into mikka_team_issues ("issueId","teamId","workspaceId","userId") values ($1,$2,$3,$4)', [id, t, w, u])
    }
    await pool.query('insert into agents (id,"userId",harness,name) values ($1,$2,\'codex\',\'narrow\')', [agent, owner])
    for (const [key, issueId, u] of [['shared', issue.shared, owner], ['personal', issue.personal, owner], ['unlinked', issue.unlinked, owner], ['foreign', issue.foreign, foreign], ['none', null, owner]] as const) {
      runs[key] = randomUUID()
      const tenant = issueId ? issueRows.find(row=>row[0]===issueId)![3] : ownerPersonal
      await pool.query('insert into agent_runs (id,"userId","issueId","agentId",status,prompt,"workspaceId") values ($1,$2,$3,$4,\'running\',\'p\',$5)', [runs[key], u, issueId, agent,tenant])
    }

    const runIssue = new Map<string, string | null>([[runs.shared, issue.shared], [runs.personal, issue.personal], [runs.unlinked, issue.unlinked], [runs.foreign, issue.foreign], [runs.none, null]])
    const allIssues: string[] = Object.values(issue)
    const subsets: string[][] = [allIssues, ...allIssues.map(id => [id]), [issue.shared, issue.foreign], [issue.personal, issue.unlinked, issue.secondTeam]]
    const visibleWith = async (user: string, ids: string[], narrow: boolean) => (await db.select({ id: issues.id }).from(issues)
      .where(and(inArray(issues.id, ids), (await issueVisibility(user, false, undefined, db, narrow ? { onlyIssueIds: ids } : {})).predicate))).map(row => row.id).sort()
    const checkAll = async (label: string) => {
      for (const user of users) for (const ids of subsets) {
        assert.deepEqual(await visibleWith(user, ids, true), await visibleWith(user, ids, false), `${label}: ${user} sees the same of ${ids.length} tasks`)
      }
      for (const user of users) {
        // citationSources asks about known tasks and runs; the full path is the expectation.
        const fullIssues = await visibleWith(user, allIssues, false)
        const fullRuns = (await visibleRuns(user, { limit: 100 })).map(run => run.id).filter(id => Object.values(runs).includes(id)).sort()
        const sources = await citationSources(user, [allIssues.map(id => `[[issue:${id}]]`).join(' '), Object.values(runs).map(id => `[[run:${id}]]`).join(' ')])
        assert.deepEqual(Object.keys(sources).filter(id => allIssues.includes(id)).sort(), fullIssues, `${label}: citationSources issues for ${user}`)
        assert.deepEqual(Object.keys(sources).filter(id => Object.values(runs).includes(id)).sort(), fullRuns, `${label}: citationSources runs for ${user}`)
        assert.deepEqual((await visibleRuns(user, { runIds: Object.values(runs), limit: 100 })).map(run => run.id).sort(), fullRuns, `${label}: visibleRuns by run ids for ${user}`)
        for (const id of allIssues) {
          const byIssue = (await visibleRuns(user, { issueId: id, limit: 100 })).map(run => run.id).sort()
          assert.deepEqual(byIssue, fullRuns.filter(runId => runIssue.get(runId) === id), `${label}: visibleRuns for one task, ${user}`)
          assert.equal((await issueForUser(user, id))?.id ?? null, fullIssues.includes(id) ? id : null, `${label}: issueForUser ${user}`)
        }
      }
    }

    await checkAll('active')
    const pinned = { id: owner, [tokenWorkspace]: workspace,
      [enterprisePrincipal]: { kind: 'pat' as const, tokenId: randomUUID(), workspaceId: workspace } }
    const batch = () => issuesForUser(pinned, [issue.shared, issue.unlinked, issue.personal, issue.foreign], false, db,
      { withoutBody: true, withTeamLinks: false })
    assert.deepEqual([...await batch()].map(([id]) => id).sort(), [issue.shared, issue.unlinked].sort(), 'pure authorization retains the reader tenant and permits genuinely unlinked tenant tasks')
    try {
      // A historical/foreign Team link cannot replace the persisted task
      // tenant or bypass the batch reader's independent token mismatch fence.
      assert.equal((await pool.query('update mikka_team_issues set "teamId"=$2,"workspaceId"=$3 where "issueId"=$1',
        [issue.shared, foreignTeam, otherWorkspace])).rowCount, 1)
      const defaults = await issuesForUser(pinned, [issue.shared], false, db, { withoutBody: true })
      assert.equal(defaults.has(issue.shared), false)
      assert.equal((await batch()).has(issue.shared), false, 'omitting grouping links must still read the exact token/link mismatch')
      const sources = await citationSources(pinned, [`[[run:${runs.shared}]]`])
      const run = sources[runs.shared]
      assert.ok(run?.kind === 'run')
      assert.equal(run.issue, null, 'the optimized run citation retains the same task denial')
    } finally {
      assert.equal((await pool.query('update mikka_team_issues set "teamId"=$2,"workspaceId"=$3 where "issueId"=$1',
        [issue.shared, team, workspace])).rowCount, 1)
    }
    assert.equal((await batch()).has(issue.shared), true, 'another operation sees the restored current link')
    assert.deepEqual(await visibleWith(member, [issue.shared, issue.secondTeam, issue.foreign, issue.personal, issue.unlinked], true), [issue.secondTeam, issue.shared, issue.unlinked].sort(), 'a teammate sees every task in the tenant, including tasks without a Team')
    assert.deepEqual(await visibleWith(member, [issue.foreign], true), [], 'another workspace\'s task stays hidden')
    assert.deepEqual(await issueTeamScope(member, [], { onlyIssueIds: [] }), [], 'no tasks asked about reads nothing')
    assert.deepEqual((await issueTeamScope(member, [], { onlyIssueIds: [issue.shared] })).map(link => Object.keys(link).sort()), [['issueId', 'teamId', 'workspaceId']], 'only the columns callers use')

    await pool.query('update mikka_workspace_members set status=\'suspended\' where "workspaceId"=$1 and "userId"=$2', [workspace, removed])
    assert.deepEqual(await visibleWith(removed, allIssues, true), [], 'a removed member sees nothing at once')
    assert.equal(await issueForUser(removed, issue.shared), null)
    assert.equal((await issuesForUser({ id: removed, [tokenWorkspace]: workspace }, [issue.shared, issue.unlinked], false, db,
      { withoutBody: true, withTeamLinks: false })).size, 0, 'pure authorization rechecks revoked membership')
    await checkAll('after removal')
  } finally {
    await pool.query('delete from agent_runs where "agentId"=$1', [agent])
    await pool.query('delete from agents where id=$1', [agent])
    await pool.query('delete from mikka_team_issues where "issueId" = any($1::uuid[])', [Object.values(issue)])
    await pool.query('delete from issues where id = any($1::uuid[])', [Object.values(issue)])
    await pool.query('delete from mikka_teams where id = any($1::uuid[])', [[team, secondTeam, foreignTeam]])
    await pool.query('delete from mikka_workspace_members where "workspaceId" = any($1::uuid[])', [[workspace, otherWorkspace, ownerPersonal, memberPersonal]])
    await pool.query('delete from mikka_workspaces where id = any($1::uuid[])', [[workspace, otherWorkspace, ownerPersonal, memberPersonal]])
    await pool.query('delete from "user" where id = any($1::text[])', [users])
    await pool.end()
  }
})
