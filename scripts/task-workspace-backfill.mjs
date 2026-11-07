import { resolveTaskWorkspace } from './task-workspace-evidence.mjs'

const workspaceUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sameRows = (left, right) => JSON.stringify(left.map(row => JSON.stringify(row)).sort()) === JSON.stringify(right.map(row => JSON.stringify(row)).sort())
const candidateWorkspaces = evidence => [...new Set(evidence.map(item => item.workspaceId).filter(id => typeof id === 'string' && workspaceUuid.test(id)).map(id => id.toLowerCase()))].sort()
const linkEvidence = `SELECT l."issueId", l."workspaceId", l."userId" AS "ownerId", 'team' AS source, l."teamId"::text AS "sourceId", t.id IS NOT NULL AS verified
  FROM mikka_team_issues l LEFT JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId"
  WHERE l."issueId"=ANY($1::uuid[])`
const projectEvidence = `SELECT requested.id AS "issueId",l."workspaceId",'project' AS source,p.id::text AS "sourceId",
    t.id IS NOT NULL AND l."userId"=p."userId" AS verified
  FROM unnest($1::uuid[]) AS requested(id) JOIN workspace_projects p ON p."issueIds" ? requested.id::text
  JOIN mikka_team_projects l ON l."projectId"=p.id
  LEFT JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId"`
const runEvidence = `SELECT r."issueId", b."workspaceId"::text, 'bot' AS source, r."botId"::text AS "sourceId", b.id IS NOT NULL AS verified
  FROM agent_runs r LEFT JOIN bots b ON b.id=r."botId" WHERE r."issueId"=ANY($1::uuid[]) AND r."botId" IS NOT NULL
  UNION SELECT f."issueId",b."workspaceId"::text,'factory',f.id::text,b.id IS NOT NULL FROM factory_tasks f LEFT JOIN bots b ON b.id=f."botId"
    WHERE f."issueId"=ANY($1::uuid[]) AND f."botId" IS NOT NULL
  UNION SELECT r."issueId",c."workspaceId"::text,'thread',r.id::text,c."ownerId"=r."userId" FROM agent_runs r JOIN computer_run_bindings c ON c."runId"=r.id WHERE r."issueId"=ANY($1::uuid[])
  UNION SELECT r."issueId",r."agentDefinition"#>>'{executionIdentity,workspaceId}','execution_identity',r.id::text,
    r."agentDefinition"#>>'{executionIdentity,workspaceId}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    FROM agent_runs r WHERE r."issueId"=ANY($1::uuid[]) AND r."agentDefinition"#>>'{executionIdentity,workspaceId}' IS NOT NULL`

async function lockWorkspaces(tenant, candidates) {
  const { rows } = candidates.length ? await tenant.query('SELECT id FROM mikka_workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [candidates]) : { rows: [] }
  return new Set(rows.map(row => row.id))
}

/** Resume safely after either database migrated or a prior batch committed.
 * This does not move already bound rows or rewrite content, identifiers, links,
 * receipts, run provenance, or provider policies. Report contains metadata only. */
export async function backfillTaskWorkspaces(application, workspace) {
  const { rows: [ready] } = await application.query(`SELECT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='issues' AND column_name='workspaceId'
  ) AS ready`)
  if (!ready.ready) return { bound: 0, pending: 0, runsBound: 0, artifactsBound: 0, factoryBound: 0 }
  const { rows: [sourceReady] } = await workspace.query(`SELECT to_regclass('mikka_workspaces') IS NOT NULL
    AND to_regclass('mikka_team_issues') IS NOT NULL AS ready`)
  if (!sourceReady.ready) return { bound: 0, pending: 0, runsBound: 0, artifactsBound: 0, factoryBound: 0 }
  let after = null, bound = 0, pending = 0
  for (;;) {
    const { rows } = await application.query(`SELECT id FROM issues WHERE "workspaceId" IS NULL
      AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 128`, [after])
    if (!rows.length) break
    const ids = rows.map(row => row.id)
    after = ids.at(-1)
    // Discovery holds no locks or checked-out APP connection while waiting
    // for workspace authority. Re-read every proof after taking the locks.
    const [observedTasks, observedLinks, observedProjects, observedRuns] = await Promise.all([
      application.query('SELECT id,"userId" FROM issues WHERE id=ANY($1::uuid[]) AND "workspaceId" IS NULL', [ids]),
      workspace.query(linkEvidence, [ids]), workspace.query(projectEvidence, [ids]), application.query(runEvidence, [ids]),
    ])
    const candidates = candidateWorkspaces([...observedLinks.rows, ...observedProjects.rows, ...observedRuns.rows])
    const tenant = await workspace.connect()
    let app
    try {
      await tenant.query('BEGIN')
      // Match normal writers: workspace -> relation/source -> application.
      // Cross-database waits cannot be detected as one PostgreSQL deadlock.
      const existing = await lockWorkspaces(tenant, candidates)
      await tenant.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka-team-relations',0))")
      const { rows: links } = await tenant.query(`${linkEvidence} FOR SHARE OF l`, [ids])
      const { rows: projects } = await tenant.query(`${projectEvidence} FOR SHARE OF p,l`, [ids])
      if (!sameRows(observedLinks.rows, links) || !sameRows(observedProjects.rows, projects)) {
        // A new source may name an unlocked tenant. Release every tenant lock
        // before recording quarantine in an independent APP transaction. The
        // next pass discovers fresh authority; no workspace lock is added here.
        await tenant.query('COMMIT')
        app = await application.connect()
        await app.query('BEGIN')
        const { rows: unresolved } = await app.query('SELECT id FROM issues WHERE id=ANY($1::uuid[]) AND "workspaceId" IS NULL ORDER BY id FOR UPDATE', [ids])
        const evidence = [...links, ...projects, ...observedRuns.rows]
        for (const { id } of unresolved) {
          const proofs = evidence.filter(item => item.issueId === id).map(({ workspaceId, source, sourceId, verified }) => ({ workspaceId, source, sourceId, ...(verified === false ? { verified } : {}) }))
          await app.query(`INSERT INTO issue_workspace_repairs ("issueId",reason,evidence) VALUES($1,'conflicting_evidence',$2)
            ON CONFLICT ("issueId") DO UPDATE SET reason=excluded.reason,evidence=excluded.evidence,"checkedAt"=now()`, [id, JSON.stringify(proofs)])
          pending++
        }
        await app.query('COMMIT')
        continue
      }
      app = await application.connect()
      await app.query('BEGIN')
      const { rows: tasks } = await app.query('SELECT id,"userId" FROM issues WHERE id=ANY($1::uuid[]) AND "workspaceId" IS NULL ORDER BY id FOR UPDATE', [ids])
      const { rows: runs } = await app.query(runEvidence, [ids])
      const owners = new Map(tasks.map(row => [row.id, row.userId]))
      const evidence = [...links.map(link => ({ ...link, verified: link.verified && link.ownerId === owners.get(link.issueId) })), ...projects, ...runs]
      for (const { id, userId } of tasks) {
        const proofs = evidence.filter(item => item.issueId === id).map(({ workspaceId, source, sourceId, verified }) => ({ workspaceId, source, sourceId, ...(verified === false ? { verified } : {}) }))
        const changed = observedTasks.rows.find(task => task.id === id)?.userId !== userId
          || !sameRows(observedRuns.rows.filter(run => run.issueId === id), runs.filter(run => run.issueId === id))
        const resolved = changed ? { workspaceId: null, reason: 'conflicting_evidence' } : resolveTaskWorkspace(proofs, existing)
        if (resolved.workspaceId) {
          const result = await app.query('UPDATE issues SET "workspaceId"=$2 WHERE id=$1 AND "workspaceId" IS NULL', [id, resolved.workspaceId])
          bound += result.rowCount
          await app.query('DELETE FROM issue_workspace_repairs WHERE "issueId"=$1', [id])
        } else {
          await app.query(`INSERT INTO issue_workspace_repairs ("issueId",reason,evidence) VALUES($1,$2,$3)
            ON CONFLICT ("issueId") DO UPDATE SET reason=excluded.reason,evidence=excluded.evidence,"checkedAt"=now()`, [id, resolved.reason, JSON.stringify(proofs)])
          pending++
        }
      }
      await app.query('COMMIT')
      await tenant.query('COMMIT')
    } catch (error) {
      await Promise.allSettled([...(app ? [app.query('ROLLBACK')] : []), tenant.query('ROLLBACK')])
      throw error
    } finally { app?.release(); tenant.release() }
  }
  const resources = await backfillDerivedResources(application, workspace)
  return { bound, pending, ...resources }
}

/** Derive only from durable task/thread/Bot authority. A personal creator is
 * deliberately absent from these candidate sets. Removed source links cannot
 * move an already bound resource on a retry. */
async function backfillDerivedResources(application, workspace) {
  let runsBound = 0, artifactsBound = 0, factoryBound = 0
  for (const kind of ['run', 'artifact', 'factory']) {
    const table = kind === 'run' ? 'agent_runs' : kind === 'factory' ? 'factory_tasks' : 'artifacts'
    let after = null
    for (;;) {
      const { rows } = await application.query(`SELECT id FROM ${table} WHERE "workspaceId" IS NULL
        AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 128`, [after])
      if (!rows.length) break
      const ids = rows.map(row => row.id)
      after = ids.at(-1)
      const resourceQuery = kind === 'run' ? `SELECT r.id,r."issueId",i."workspaceId"::text AS task,
        b."workspaceId"::text AS bot,r."agentDefinition"#>>'{executionIdentity,workspaceId}' AS frozen,c."workspaceId"::text AS computer
        FROM agent_runs r LEFT JOIN issues i ON i.id=r."issueId" LEFT JOIN bots b ON b.id=r."botId"
        LEFT JOIN computer_run_bindings c ON c."runId"=r.id AND c."ownerId"=r."userId" WHERE r.id=ANY($1::uuid[]) AND r."workspaceId" IS NULL`
        : kind === 'factory' ? `SELECT f.id,f."issueId",i."workspaceId"::text AS task,b."workspaceId"::text AS bot
        FROM factory_tasks f LEFT JOIN issues i ON i.id=f."issueId" LEFT JOIN bots b ON b.id=f."botId"
        WHERE f.id=ANY($1::uuid[]) AND f."workspaceId" IS NULL`
        : `SELECT a.id,a."issueId",i."workspaceId"::text AS task,r."workspaceId"::text AS run,a."runId"
        FROM artifacts a LEFT JOIN issues i ON i.id=a."issueId" LEFT JOIN agent_runs r ON r.id=a."runId" AND r."userId"=a."userId"
        WHERE a.id=ANY($1::uuid[]) AND a."workspaceId" IS NULL`
      const { rows: observed } = await application.query(resourceQuery, [ids])
      const candidates = candidateWorkspaces(observed.flatMap(row => ['task','bot','frozen','computer','run'].map(source => ({ workspaceId: row[source] }))))
      const tenant = await workspace.connect()
      let app
      try {
        await tenant.query('BEGIN')
        const existing = await lockWorkspaces(tenant, candidates)
        app = await application.connect()
        await app.query('BEGIN')
        await app.query(`SELECT id FROM ${table} WHERE id=ANY($1::uuid[]) AND "workspaceId" IS NULL ORDER BY id FOR UPDATE`, [ids])
        // A joined locking SELECT can retain source rows from its snapshot
        // while it waits for the resource. Start a new statement after the
        // lock is acquired so computer/task/Bot evidence is actually fresh.
        const { rows: resources } = await app.query(resourceQuery, [ids])
        for (const row of resources) {
          if (!sameRows(observed.filter(previous => previous.id === row.id), [row])) continue
          const proofs = ['task','bot','frozen','computer','run'].filter(source => row[source]).map(source => ({ workspaceId: row[source], source, sourceId: row.id }))
          const resolved = resolveTaskWorkspace(proofs, existing)
          const unresolvedParent = (row.issueId && !row.task) || (row.runId && !row.run)
          if (resolved.workspaceId && !unresolvedParent) {
            const result = await app.query(`UPDATE ${table} SET "workspaceId"=$2 WHERE id=$1 AND "workspaceId" IS NULL`, [row.id, resolved.workspaceId])
            if (kind === 'run') runsBound += result.rowCount
            else if (kind === 'factory') factoryBound += result.rowCount
            else artifactsBound += result.rowCount
          }
        }
        await app.query('COMMIT'); await tenant.query('COMMIT')
      } catch (error) {
        await Promise.allSettled([...(app ? [app.query('ROLLBACK')] : []), tenant.query('ROLLBACK')]); throw error
      } finally { app?.release(); tenant.release() }
    }
  }
  return { runsBound, artifactsBound, factoryBound }
}
