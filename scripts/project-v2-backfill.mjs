const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const unique = values => [...new Set(values)].sort()
const taskIds = project => Array.isArray(project.issueIds) ? unique(project.issueIds.filter(id => typeof id === 'string' && uuid.test(id)).map(id => id.toLowerCase())) : []
const identities = project => unique([project.leadUserId ?? project.lead, ...(Array.isArray(project.properties?.members) ? project.properties.members : [])]
  .filter(value => typeof value === 'string' && value).map(value => value === 'me' ? project.userId : value))
const same = (left, right) => JSON.stringify(left.map(row => JSON.stringify(row)).sort()) === JSON.stringify(right.map(row => JSON.stringify(row)).sort())

/** Only durable Team links and immutable task tenants are evidence. Neither a
 * creator's personal tenant nor display names are admissible fallback inputs. */
export function resolveProjectWorkspace(project, teams, tasks, existingWorkspaces, conflictingTasks = []) {
  const ids = taskIds(project)
  if (!Array.isArray(project.issueIds) || project.issueIds.some(id => typeof id !== 'string' || !uuid.test(id))) return { workspaceId: null, reason: 'invalid_task_ids' }
  if (conflictingTasks.some(id => ids.includes(id))) return { workspaceId: null, reason: 'conflicting_task_projects' }
  if (teams.some(team => !team.verified)) return { workspaceId: null, reason: 'conflicting_evidence' }
  if (ids.some(id => !tasks.some(task => task.id === id && task.workspaceId && task.ownershipState === 'bound'))) return { workspaceId: null, reason: 'unresolved_tasks' }
  const candidates = unique([project.workspaceId, ...teams.map(team => team.workspaceId), ...tasks.filter(task => ids.includes(task.id)).map(task => task.workspaceId)].filter(Boolean))
  if (!candidates.length) return { workspaceId: null, reason: 'missing_evidence' }
  if (candidates.length !== 1) return { workspaceId: null, reason: 'conflicting_evidence' }
  if (!existingWorkspaces.has(candidates[0])) return { workspaceId: null, reason: 'missing_workspace' }
  return { workspaceId: candidates[0], reason: null }
}

const projectQuery = `SELECT p.id,p."workspaceId",p."userId",p."leadUserId",p.lead,p.properties,p."issueIds" FROM workspace_projects p
  WHERE p.id=ANY($1::uuid[]) AND NOT EXISTS (SELECT 1 FROM workspace_project_v2_migrations m WHERE m."projectId"=p.id)`
const teamQuery = `SELECT l."projectId",l."workspaceId",l."teamId",l."userId",t.id IS NOT NULL AND l."userId"=p."userId" AS verified
  FROM mikka_team_projects l JOIN workspace_projects p ON p.id=l."projectId"
  LEFT JOIN mikka_teams t ON t.id=l."teamId" AND t."workspaceId"=l."workspaceId" WHERE l."projectId"=ANY($1::uuid[])`

async function readTasks(executor, ids, lock = false) {
  const rows = []
  for (let offset = 0; offset < ids.length; offset += 200) {
    const result = await executor.query(`SELECT id,"workspaceId","ownershipState" FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id${lock ? ' FOR SHARE' : ''}`, [ids.slice(offset, offset + 200)])
    rows.push(...result.rows)
  }
  return rows
}

async function conflictingTaskIds(executor, ids) {
  const conflicts = []
  for (let offset = 0; offset < ids.length; offset += 200) {
    const { rows } = await executor.query(`WITH candidates AS (
      SELECT e.value::uuid AS "issueId",p.id AS "projectId" FROM workspace_projects p
      CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(p."issueIds")='array' THEN p."issueIds" ELSE '[]'::jsonb END) e(value)
      WHERE e.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        AND lower(e.value)=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM workspace_project_v2_migrations m WHERE m."projectId"=p.id)
      UNION SELECT "issueId","projectId" FROM workspace_project_tasks WHERE "issueId"=ANY($1::uuid[])
    ) SELECT "issueId" FROM candidates GROUP BY "issueId" HAVING count(DISTINCT "projectId")>1`, [ids.slice(offset, offset + 200)])
    conflicts.push(...rows.map(row => row.issueId))
  }
  return conflicts
}

/** Bounded, resumable split-database migration. Preserve every UUID, revision,
 * timestamp, event, milestone and dependency; legacy JSONB is never dual-written. */
export async function backfillProjectV2(application, workspace) {
  const { rows: [ready] } = await workspace.query(`SELECT to_regclass('workspace_project_v2_migrations') IS NOT NULL AS ready`)
  if (!ready.ready) return { projectsBound: 0, projectTasksBound: 0, projectsPending: 0 }
  let after = null, projectsBound = 0, projectTasksBound = 0, projectsPending = 0
  for (;;) {
    const { rows: batch } = await workspace.query(`SELECT p.id FROM workspace_projects p
      WHERE ($1::uuid IS NULL OR p.id>$1) AND NOT EXISTS (SELECT 1 FROM workspace_project_v2_migrations m WHERE m."projectId"=p.id)
      ORDER BY p.id LIMIT 64`, [after])
    if (!batch.length) break
    const ids = batch.map(row => row.id)
    after = ids.at(-1)
    const observedProjects = (await workspace.query(projectQuery, [ids])).rows
    const observedTeams = (await workspace.query(teamQuery, [ids])).rows
    const issueIds = unique(observedProjects.flatMap(taskIds))
    const observedTasks = await readTasks(application, issueIds)
    const candidates = unique([...observedProjects.map(project => project.workspaceId), ...observedTeams.map(team => team.workspaceId), ...observedTasks.map(task => task.workspaceId)].filter(Boolean))
    const peopleIds = unique(observedProjects.flatMap(identities))
    const tenant = await workspace.connect()
    let app
    try {
      await tenant.query('BEGIN')
      const existing = new Set(candidates.length ? (await tenant.query('SELECT id FROM mikka_workspaces WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE', [candidates])).rows.map(row => row.id) : [])
      const people = candidates.length && peopleIds.length ? (await tenant.query(`SELECT "workspaceId","userId" FROM mikka_workspace_members
        WHERE "workspaceId"=ANY($1::uuid[]) AND "userId"=ANY($2::text[]) AND status='active' ORDER BY "workspaceId","userId" FOR SHARE`, [candidates, peopleIds])).rows : []
      await tenant.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka-team-relations',0))")
      const projects = (await tenant.query(`${projectQuery} ORDER BY p.id FOR UPDATE OF p`, [ids])).rows
      const teams = (await tenant.query(`${teamQuery} FOR SHARE OF l`, [ids])).rows
      app = await application.connect()
      await app.query('BEGIN')
      const tasks = await readTasks(app, issueIds, true)
      const conflicts = await conflictingTaskIds(tenant, issueIds)
      for (const project of projects) {
        const previous = observedProjects.find(item => item.id === project.id)
        const links = teams.filter(team => team.projectId === project.id)
        const linkedIds = taskIds(project)
        const changed = !previous || !same([previous], [project]) || !same(links, observedTeams.filter(team => team.projectId === project.id))
          || !same(tasks.filter(task => linkedIds.includes(task.id)), observedTasks.filter(task => linkedIds.includes(task.id)))
        const resolution = changed ? { workspaceId: null, reason: 'conflicting_evidence' } : resolveProjectWorkspace(project, links, tasks, existing, conflicts)
        if (!resolution.workspaceId) {
          const evidence = [...links.map(link => ({ source: 'team', id: link.teamId, workspaceId: link.workspaceId, verified: link.verified })),
            ...tasks.filter(task => linkedIds.includes(task.id)).map(task => ({ source: 'task', id: task.id, workspaceId: task.workspaceId })),
            ...conflicts.filter(id => linkedIds.includes(id)).map(id => ({ source: 'duplicate_project_task', id }))]
          await tenant.query(`INSERT INTO workspace_project_repairs("projectId",reason,evidence) VALUES($1,$2,$3::jsonb)
            ON CONFLICT("projectId") DO UPDATE SET reason=excluded.reason,evidence=excluded.evidence,"checkedAt"=now()`, [project.id, resolution.reason, JSON.stringify(evidence)])
          projectsPending++
          continue
        }
        const workspaceId = resolution.workspaceId
        const active = new Set(people.filter(person => person.workspaceId === workspaceId).map(person => person.userId))
        const identity = value => value === 'me' ? project.userId : value
        const legacyLead = identity(project.leadUserId ?? project.lead)
        const leadUserId = active.has(legacyLead) ? legacyLead : null
        await tenant.query('UPDATE workspace_projects SET "workspaceId"=$2,"leadUserId"=$3 WHERE id=$1 AND ("workspaceId" IS NULL OR "workspaceId"=$2)', [project.id, workspaceId, leadUserId])
        for (let offset = 0; offset < linkedIds.length; offset += 200) {
          const inserted = await tenant.query(`INSERT INTO workspace_project_tasks("issueId","projectId","workspaceId")
            SELECT id,$2,$3 FROM unnest($1::uuid[]) id ON CONFLICT("issueId") DO NOTHING`, [linkedIds.slice(offset, offset + 200), project.id, workspaceId])
          projectTasksBound += inserted.rowCount
        }
        const members = unique((Array.isArray(project.properties?.members) ? project.properties.members : []).map(identity).filter(id => active.has(id)))
        for (let offset = 0; offset < members.length; offset += 200) {
          await tenant.query(`INSERT INTO workspace_project_members("projectId","workspaceId","userId")
            SELECT $1,$2,id FROM unnest($3::text[]) id ON CONFLICT DO NOTHING`, [project.id, workspaceId, members.slice(offset, offset + 200)])
        }
        await tenant.query('INSERT INTO workspace_project_v2_migrations("projectId") VALUES($1) ON CONFLICT DO NOTHING', [project.id])
        await tenant.query('DELETE FROM workspace_project_repairs WHERE "projectId"=$1', [project.id])
        projectsBound++
      }
      // This migration mutates only the Workspace DB; APP's shared task locks
      // remain held until its canonical relationships are committed.
      await tenant.query('COMMIT')
      await app.query('COMMIT')
    } catch (error) {
      await Promise.allSettled([tenant.query('ROLLBACK'), ...(app ? [app.query('ROLLBACK')] : [])])
      throw error
    } finally { app?.release(); tenant.release() }
  }
  return { projectsBound, projectTasksBound, projectsPending }
}
