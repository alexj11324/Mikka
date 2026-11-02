// Gives every demo thread that has no task its own task, in place: no re-seed.
// Work reaches a thread only through a task (dispatch_run requires an issueId);
// seeds before #985 wrote Bot threads with issueId null.
//
//   MIKKA_DATABASE_URL=… DATABASE_URL=… node scripts/demo-data/backfill-issues.mjs --email you@example.com          # dry run: counts
//   MIKKA_DATABASE_URL=… DATABASE_URL=… node scripts/demo-data/backfill-issues.mjs --email you@example.com --apply  # write
//
// It touches only that account's demo runs (id starting de300000-) that have no
// task and are not group chats. For each it writes what a seeded task has: an
// `issues` row (workspace scope, Linear sync blocked, no number), its first
// `issue_versions` row and its `mikka_team_issues` link to the demo team, then
// sets the run's issueId. One transaction; task ids derive from the run id, so a
// second run finds nothing and writes nothing. cleanup.mjs removes these tasks
// like every other demo row.
import { connect, DEMO_PREFIX, demoId, findOwner, parseArgs } from './shared.mjs'
import { taskStatus, threadTitle } from './thread-issues.mjs'

/** The demo runs this account still has without a task. */
export async function backfillPlan(client, ownerId) {
  const { rows } = await client.query(`
    SELECT r.id, r.status, r.prompt, r."createdAt", coalesce(r."lastReplyAt", r."updatedAt", r."createdAt") AS "updatedAt",
           b.id AS "botId", b.name AS "botName", b."workspaceId", t.id AS "teamId"
      FROM agent_runs r
      JOIN bots b ON b.id = r."botId" AND b."ownerId" = r."userId" AND b.id::text LIKE $2
      LEFT JOIN mikka_teams t ON t."workspaceId" = b."workspaceId" AND t.id::text LIKE $2
     WHERE r."userId" = $1 AND r.id::text LIKE $2 AND r."issueId" IS NULL AND r.kind IS DISTINCT FROM 'group_chat'
     ORDER BY r."createdAt", r.id`, [ownerId, `${DEMO_PREFIX}%`])
  return rows.map(run => {
    if (!run.teamId) throw new Error(`Demo run ${run.id} has no demo team in its workspace; stopping.`)
    const issueId = demoId(ownerId, `issue:backfill:${run.id}`)
    const metadata = {
      assignee: { kind: 'agent', id: run.botId, name: run.botName, image: null }, project: null, labels: [], pullRequests: [],
      parentId: null, blockedByIds: [], relatedIds: [], duplicateOfId: null, dueDate: null, estimate: null,
      favoriteUserIds: [], subscriberUserIds: [ownerId], deletedAt: null,
    }
    return {
      runId: run.id, issueId, versionId: demoId(ownerId, `issue-version:backfill:${run.id}`), teamId: run.teamId, workspaceId: run.workspaceId,
      title: threadTitle(run.prompt) || run.botName, status: taskStatus(run.status), content: { type: 'doc', attrs: { mikka: metadata }, content: [] },
      createdAt: run.createdAt, updatedAt: run.updatedAt,
    }
  })
}

/** Writes the plan in the caller's transaction; returns the rows written per table. */
export async function applyBackfill(client, ownerId, plan) {
  const written = { issues: 0, issue_versions: 0, mikka_team_issues: 0, agent_runs: 0 }
  for (const task of plan) {
    const json = JSON.stringify(task.content)
    written.issues += (await client.query(`INSERT INTO issues (id, "userId", title, content, status, priority, scope, "scopeSetBy", "linearSyncBlocked", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'normal', 'workspace', 'user', true, $6, $7) ON CONFLICT (id) DO NOTHING`, [task.issueId, ownerId, task.title, json, task.status, task.createdAt, task.updatedAt])).rowCount
    written.issue_versions += (await client.query(`INSERT INTO issue_versions (id, "issueId", "userId", revision, title, content, status, priority, actor_type, actor_id, "createdAt")
      VALUES ($1, $2, $3, 1, $4, $5, $6, 'normal', 'user', $3, $7) ON CONFLICT (id) DO NOTHING`, [task.versionId, task.issueId, ownerId, task.title, json, task.status, task.createdAt])).rowCount
    written.mikka_team_issues += (await client.query(`INSERT INTO mikka_team_issues ("issueId", "teamId", "workspaceId", "userId") VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [task.issueId, task.teamId, task.workspaceId, ownerId])).rowCount
    written.agent_runs += (await client.query(`UPDATE agent_runs SET "issueId" = $1 WHERE id = $2 AND "userId" = $3 AND "issueId" IS NULL AND id::text LIKE $4`,
      [task.issueId, task.runId, ownerId, `${DEMO_PREFIX}%`])).rowCount
  }
  return written
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const db = connect(args)
  try {
    const same = db.targets.main.host === db.targets.workspace.host && db.targets.main.database === db.targets.workspace.database
    if (!same) throw new Error('Tasks and their workspace links live in different databases here; one transaction cannot cover both. Stopping.')
    const owner = await findOwner(db.main, args.email)
    const client = await db.main.connect()
    try {
      await client.query('BEGIN')
      const plan = await backfillPlan(client, owner.id)
      const planned = { runs: plan.length, issues: plan.length, issue_versions: plan.length, mikka_team_issues: plan.length, byStatus: plan.reduce((acc, task) => ({ ...acc, [task.status]: (acc[task.status] ?? 0) + 1 }), {}), workspaces: [...new Set(plan.map(task => task.workspaceId))] }
      const written = args.apply ? await applyBackfill(client, owner.id, plan) : null
      if (written && Object.values(written).some(count => count !== plan.length)) throw new Error(`Wrote ${JSON.stringify(written)} for ${plan.length} runs; rolled back.`)
      await client.query(args.apply ? 'COMMIT' : 'ROLLBACK')
      console.log(JSON.stringify({ mode: args.apply ? 'apply' : 'dry-run', targets: db.targets, owner: owner.id, planned, written }, null, 2))
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
  } finally { await db.main.end(); await db.workspace.end() }
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
