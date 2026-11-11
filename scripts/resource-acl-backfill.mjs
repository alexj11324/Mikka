// Projects remain in the Workspace database. Only proven stable identifiers
// cross the boundary; this migration never joins databases or copies content.
const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i

export async function backfillProjectResourceAccess(application, workspace) {
  const { rows: [ready] } = await application.query("select to_regclass('resource_access_policies') is not null as ready")
  if (!ready.ready) return { registered: 0, quarantined: 0, tasksBound: 0 }
  const { rows: [source] } = await workspace.query("select to_regclass('workspace_projects') is not null as ready")
  if (!source.ready) return { registered: 0, quarantined: 0, tasksBound: 0 }
  // After #1687's Project v2 migration the canonical Workspace and the canonical
  // Task relation are the only authority. The legacy Team-link/owner inference
  // runs only when those columns/tables do not exist yet, so one deploy never
  // uses two different Project identities at the same time.
  const { rows: [shape] } = await workspace.query(`select
    exists(select 1 from information_schema.columns where table_schema=current_schema()
      and table_name='workspace_projects' and column_name='workspaceId') as canonical,
    to_regclass('workspace_project_tasks') is not null as relations`)
  const result = { registered: 0, quarantined: 0, tasksBound: 0 }
  let cursor = null
  while (true) {
    const { rows: batch } = await workspace.query('select id from workspace_projects where ($1::uuid is null or id>$1) order by id limit 128', [cursor])
    if (!batch.length) break
    for (const { id } of batch) {
      const tenant = await workspace.connect()
      let app
      try {
        await tenant.query('begin')
        await tenant.query("select pg_advisory_xact_lock(hashtextextended('mikka-team-relations',0))")
        let bound = null, ownerId = null, visibility = 'quarantined', provenance = 'quarantined', ids = []
        if (shape.canonical) {
          const { rows: [project] } = await tenant.query('select id,"userId","workspaceId" from workspace_projects where id=$1 for share', [id])
          if (!project) { await tenant.query('commit'); continue }
          ownerId = project.userId
          if (project.workspaceId) {
            // Match Project mutations: lock the canonical Workspace before the
            // relation advisory lock is irrelevant here, but keep Workspace
            // authority first and read its kind under that lock.
            const { rows: [workspaceRow] } = await tenant.query(`select w.id,w.kind,w."userId" from mikka_workspaces w
              where w.id=$1 for share`, [project.workspaceId])
            const assigned = workspaceRow && (workspaceRow.kind === 'team'
              || (workspaceRow.kind === 'personal' && workspaceRow.userId === project.userId))
            if (assigned) {
              bound = project.workspaceId
              visibility = workspaceRow.kind === 'team' ? 'shared' : 'private'
              provenance = workspaceRow.kind === 'team' ? 'legacy_shared_project' : 'legacy_private_project'
            }
          }
          if (bound && shape.relations) {
            const { rows: relations } = await tenant.query(`select "issueId" from workspace_project_tasks
              where "projectId"=$1 and "workspaceId"=$2 order by "issueId"`, [id, bound])
            ids = relations.map(row => row.issueId).filter(value => typeof value === 'string' && uuid.test(value))
          }
        } else {
          // Legacy deploy path. Keys are captured only for the ACL boundary;
          // they are not a second Project identity in the canonical model.
          const candidates = await tenant.query(`select distinct w.id from mikka_workspaces w
            where w.id in (select "workspaceId" from mikka_team_projects where "projectId"=$1)
              or (w.kind='personal' and w."userId"=(select "userId" from workspace_projects where id=$1)) order by w.id`, [id])
          if (candidates.rows.length) await tenant.query('select id from mikka_workspaces where id=any($1::uuid[]) order by id for share', [candidates.rows.map(row => row.id)])
          const { rows: [project] } = await tenant.query('select id,"userId","issueIds" from workspace_projects where id=$1 for share', [id])
          if (!project) { await tenant.query('commit'); continue }
          ownerId = project.userId
          const { rows: links } = await tenant.query(`select l."workspaceId",t.id is not null and w.id is not null and l."userId"=$2 as verified
            from mikka_team_projects l left join mikka_teams t on t.id=l."teamId" and t."workspaceId"=l."workspaceId"
            left join mikka_workspaces w on w.id=l."workspaceId" where l."projectId"=$1`, [id, project.userId])
          const { rows: personal } = links.length ? { rows: [] } : await tenant.query("select id from mikka_workspaces where kind='personal' and \"userId\"=$1", [project.userId])
          const workspaces = [...new Set(links.filter(link => link.verified).map(link => link.workspaceId))]
          const workspaceId = links.length && links.every(link => link.verified) && workspaces.length === 1
            ? workspaces[0] : !links.length && personal.length === 1 ? personal[0].id : null
          // The optimistic candidate read cannot authorize an unlocked Workspace.
          const locked = new Set(candidates.rows.map(row => row.id))
          bound = workspaceId && locked.has(workspaceId) ? workspaceId : null
          visibility = !bound ? 'quarantined' : links.length ? 'shared' : 'private'
          provenance = !bound ? 'quarantined' : links.length ? 'legacy_shared_project' : 'legacy_private_project'
          if (Array.isArray(project.issueIds)) ids = [...new Set(project.issueIds.filter(value => typeof value === 'string' && uuid.test(value)))]
        }
        app = await application.connect()
        await app.query('begin')
        await app.query("select set_config('mikka.acl_source','project_acl_backfill',true)")
        const added = await app.query(`insert into resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
          values('project',$1,$2,$3,$4,$5) on conflict(kind,id) do nothing returning id`,
        [id, bound, ownerId, visibility, provenance])
        if (added.rowCount) { result.registered++; if (!bound) result.quarantined++ }
        if (ids.length) {
          // A canonical relation can name one Project only. The legacy JSONB
          // path still counts claims so a conflict is quarantined, never
          // resolved by traversal order.
          let unique = ids
          if (!shape.canonical) {
            const { rows: associations } = await tenant.query(`select task.id,count(p.id)::integer as total from unnest($1::uuid[]) task(id)
              join workspace_projects p on p."issueIds" ? task.id::text group by task.id`, [ids])
            unique = associations.filter(row => row.total === 1).map(row => row.id)
            const ambiguous = associations.filter(row => row.total !== 1).map(row => row.id)
            if (ambiguous.length) await app.query(`update resource_access_policies set visibility='quarantined'
              where kind='task' and id=any($1::uuid[]) and provenance='legacy_shared_task' and visibility<>'quarantined'`, [ambiguous])
          }
          // Historical Tasks may only gain a boundary, never lose one. Modern
          // user changes have provenance=created and are never overwritten.
          if (unique.length) {
            const boundTasks = await app.query(`update resource_access_policies p set "parentKind"='project',"parentId"=$1,
              visibility=case when $2::uuid is null or p."workspaceId" is distinct from $2 then 'quarantined' else p.visibility end
              where p.kind='task' and p.id=any($3::uuid[]) and p.provenance='legacy_shared_task' and p."parentId" is null returning id`, [id, bound, unique])
            result.tasksBound += boundTasks.rowCount
          }
        }
        await app.query('commit')
        await tenant.query('commit')
      } catch (error) {
        await Promise.allSettled([...(app ? [app.query('rollback')] : []), tenant.query('rollback')])
        throw error
      } finally { app?.release(); tenant.release() }
    }
    cursor = batch.at(-1).id
  }
  return result
}
