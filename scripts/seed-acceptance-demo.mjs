import { createHash } from 'node:crypto'
import { Pool } from 'pg'

const email = process.argv[2]
if (!/^acceptance-[\da-f-]+@preview\.mikka\.invalid$/.test(email ?? '')) throw new Error('Provide an existing Acceptance Guest email')
const main = new Pool({ connectionString: process.env.MIKKA_DATABASE_URL, max: 1 })
const projects = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 })
const id = key => {
  const h = createHash('sha256').update(`${email}:demo-v1:${key}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}
const groups = [
  { name: '工作区协作体验', summary: '统一任务管理、成员协作和项目进度，完成工作区体验升级。', status: 'started', health: 'onTrack', color: 'purple', tasks: ['梳理团队协作流程', '完善任务详情与活动记录', '实现状态标签与优先级选择', '评审成员权限与协作体验', '完成项目概览布局', '取消旧版导航实验', '合并重复的成员搜索需求'] },
  { name: 'Agent 执行平台', summary: '完善任务分配、执行反馈和异常恢复，建立可追踪的自动化流程。', status: 'planned', health: 'atRisk', color: 'yellow', tasks: ['设计执行队列调度方案', '补充执行日志检索', '优化任务运行反馈', '评审失败重试策略', '完成任务结果展示', '取消冗余的执行状态', '合并重复的日志筛选需求'] },
  { name: '产品发布与质量保障', summary: '覆盖核心流程回归、无障碍检查和发布验收。', status: 'completed', health: 'onTrack', color: 'green', tasks: ['规划下一版本验收范围', '补充移动端回归用例', '检查发布前关键路径', '评审暗色主题对比度', '完成首轮验收测试', '取消过期的测试计划', '合并重复的兼容性问题'] },
]
const statuses = ['backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate']
const priorities = ['low', 'normal', 'high', 'urgent']
try {
  const { rows: [guest] } = await main.query('SELECT id,name,email FROM "user" WHERE email=$1 AND name=$2', [email, 'Acceptance Guest'])
  if (!guest) throw new Error('Existing guest not found; no data written')
  const members = [guest, ...['林晓（演示）', '陈予（演示）', '周宁（演示）'].map((name, i) => ({ id: id(`member-${i}`), name, email: `demo-${id(`member-${i}`)}@preview.mikka.invalid` }))]
  const seedWorkspaceId = id('workspace')
  const projectIds = groups.map((_, g) => id(`project-${g}`))
  const taskIds = groups.flatMap((group, g) => group.tasks.map((_, i) => id(`issue-${g}-${i}`)))
  // Synthetic identities live in APP. The explicitly named fixture Workspace
  // and its live memberships live in WS, even when the targets are separate.
  await main.query('BEGIN')
  try {
    await main.query('SELECT pg_advisory_xact_lock(hashtext($1))', [guest.id])
    for (const member of members.slice(1)) {
      await main.query('INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt") VALUES ($1,$2,$3,false,now(),now()) ON CONFLICT (id) DO NOTHING', [member.id, member.name, member.email])
      const current = (await main.query('SELECT email FROM "user" WHERE id=$1', [member.id])).rows[0]
      if (current?.email !== member.email) throw new Error('Demo identity conflicts with existing data; no ownership inferred')
    }
    await main.query('COMMIT')
  } catch (error) { await main.query('ROLLBACK'); throw error }

  // Keep Workspace/member/relation leases through both commits. A partial APP
  // commit leaves correctly owned ungrouped Tasks; retry can finish the new
  // Project atomically without resurrecting relations on existing Projects.
  await projects.query('BEGIN')
  try {
    await projects.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`acceptance-demo:${guest.id}`])
    const createdWorkspace = await projects.query('INSERT INTO mikka_workspaces (id,"userId",name,kind) VALUES ($1,$2,$3,\'team\') ON CONFLICT (id) DO NOTHING RETURNING id', [seedWorkspaceId, guest.id, 'Mikka'])
    const seedWorkspace = (await projects.query('SELECT id,"userId",kind FROM mikka_workspaces WHERE id=$1 FOR UPDATE', [seedWorkspaceId])).rows[0]
    if (seedWorkspace?.userId !== guest.id || seedWorkspace.kind !== 'team') throw new Error('Demo Workspace conflicts with existing data; no ownership inferred')
    for (const member of members) {
      const role = member.id === guest.id ? 'admin' : 'member'
      if (createdWorkspace.rowCount) await projects.query('INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status) VALUES ($1,$2,$3,$4,$5,\'active\')', [seedWorkspace.id, member.id, member.name, member.email, role])
      const current = (await projects.query('SELECT role,status FROM mikka_workspace_members WHERE "workspaceId"=$1 AND "userId"=$2 FOR SHARE', [seedWorkspace.id, member.id])).rows[0]
      if (current?.status !== 'active' || (member.id === guest.id && current.role !== 'admin')) throw new Error('Demo membership is inactive; existing access is not restored by seeding')
    }
    await projects.query("SELECT pg_advisory_xact_lock(hashtextextended('mikka-team-relations',0))")
    const existingProjects = (await projects.query(`SELECT p.id,p."userId",p."workspaceId",EXISTS(SELECT 1 FROM workspace_project_v2_migrations m WHERE m."projectId"=p.id) AS migrated
      FROM workspace_projects p WHERE p.id=ANY($1::uuid[]) ORDER BY p.id FOR UPDATE OF p`, [projectIds])).rows
    if (existingProjects.some(project => project.userId !== guest.id || project.workspaceId !== seedWorkspace.id || !project.migrated)) throw new Error('Existing demo Project needs reviewed ownership migration; no owner-based repair performed')
    await main.query('BEGIN')
    try {
      await main.query('SELECT pg_advisory_xact_lock(hashtext($1))', [guest.id])
      const existingTasks = (await main.query('SELECT id,"userId","workspaceId","ownershipState" FROM issues WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE', [taskIds])).rows
      if (existingTasks.some(task => task.userId !== guest.id || task.workspaceId !== seedWorkspace.id || task.ownershipState !== 'bound')) throw new Error('Existing demo Task needs reviewed ownership migration; no owner-based repair performed')
      const existingTaskIds = new Set(existingTasks.map(task => task.id))
      const { rows: [number] } = await main.query(`SELECT COALESCE(MAX((content->'attrs'->'mikka'->>'number')::int),0) AS n FROM issues WHERE "userId"=$1`, [guest.id])
      let next = Number(number.n)
      for (const [g, group] of groups.entries()) for (const [i, title] of group.tasks.entries()) {
        const issueId = id(`issue-${g}-${i}`)
        if (existingTaskIds.has(issueId)) continue
        const member = members[(g + i) % members.length]
        const metadata = { number: ++next, assignee: { kind: 'member', id: member.id, name: member.name, image: null }, labels: [{ name: '演示数据', color: 'gray' }, { name: ['体验优化', '平台开发', '质量保障'][g], color: ['violet', 'blue', 'green'][g] }], pullRequests: [], parentId: i === 1 ? id(`issue-${g}-0`) : null, blockedByIds: i === 2 ? [id(`issue-${g}-1`)] : [], relatedIds: i === 3 ? [id(`issue-${g}-2`)] : [], duplicateOfId: i === 6 ? id(`issue-${g}-1`) : null, dueDate: `2026-11-${String(2 + g * 7 + i).padStart(2, '0')}`, estimate: [1, 2, 3, 5][i % 4], favoriteUserIds: i === 2 ? [guest.id] : [], subscriberUserIds: [guest.id], deletedAt: null }
        const content = { type: 'doc', attrs: { mikka: metadata }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `这是 ${group.name} 的演示任务，支持编辑、状态切换、成员分配和项目关联。` }] }, { type: 'paragraph', content: [{ type: 'text', text: '验收标准：交互反馈清晰；刷新后数据保留；桌面与移动端均可使用。' }] }] }
        const inserted = await main.query(`INSERT INTO issues (id,"userId","workspaceId",scope,"linearSyncPolicy","linearSyncBlocked",title,content,status,priority,revision)
          VALUES ($1,$2,$3,'workspace','disabled',true,$4,$5,$6,$7,1) ON CONFLICT (id) DO NOTHING RETURNING id`, [issueId, guest.id, seedWorkspace.id, title, JSON.stringify(content), statuses[i], priorities[(g + i) % 4]])
        if (inserted.rowCount) {
          await main.query('INSERT INTO issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id) VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9)', [id(`version-${g}-${i}`), issueId, guest.id, title, JSON.stringify(content), statuses[i], priorities[(g + i) % 4], 'system', 'acceptance-seed'])
          for (const collaborator of members.slice(1)) await main.query('INSERT INTO issue_members ("issueId","userId","memberId") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [issueId, guest.id, collaborator.id])
        }
      }
      await main.query('COMMIT')
    } catch (error) { await main.query('ROLLBACK'); throw error }
    for (const [g, group] of groups.entries()) {
      if (existingProjects.some(project => project.id === id(`project-${g}`))) continue
      const properties = { color: group.color, health: group.health, members: [guest.id], labels: ['演示数据', ['体验优化', '平台开发', '质量保障'][g]], dependencyIds: g === 1 ? [id('project-0')] : [], milestones: [{ id: id(`milestone-${g}-0`), name: '需求评审', targetDate: '2026-10-28', completed: true }, { id: id(`milestone-${g}-1`), name: '发布验收', targetDate: '2026-11-25', completed: group.status === 'completed' }] }
      await projects.query(`INSERT INTO workspace_projects (id,"userId","workspaceId",name,summary,description,status,priority,lead,"leadUserId",team,"startDate","targetDate",properties,"issueIds",revision)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$2,$2,'Mikka','2026-10-20','2026-11-25',$9,'[]',1)`, [id(`project-${g}`), guest.id, seedWorkspace.id, group.name, group.summary, `${group.summary}\n\n此项目为 Acceptance Guest 的可编辑演示数据。`, group.status, ['high', 'urgent', 'normal'][g], JSON.stringify(properties)])
      await projects.query('INSERT INTO workspace_project_members ("projectId","workspaceId","userId") VALUES ($1,$2,$3)', [id(`project-${g}`), seedWorkspace.id, guest.id])
      // Projects live in the Workspace database; their content ACL is an APP
      // row keyed by the same stable id. Seeded demo data must be readable by
      // the same current ACL readers as a Project created through the API.
      // This APP write is intentionally outside the WS transaction: a later WS
      // rollback can leave only an unreachable policy, never an unguarded row.
      await main.query(`INSERT INTO resource_access_policies(kind,id,"workspaceId","ownerId",visibility,provenance)
        VALUES ('project',$1,$2,$3,$4,'created') ON CONFLICT(kind,id) DO NOTHING`,
      [id(`project-${g}`), seedWorkspace.id, guest.id, seedWorkspace.kind === 'team' ? 'shared' : 'private'])
      await projects.query('INSERT INTO workspace_project_tasks ("projectId","workspaceId","issueId") SELECT $1,$2,task FROM unnest($3::uuid[]) task', [id(`project-${g}`), seedWorkspace.id, group.tasks.map((_, i) => id(`issue-${g}-${i}`))])
      await projects.query('INSERT INTO workspace_project_events (id,"userId","projectId",message) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING', [id(`event-${g}`), guest.id, id(`project-${g}`), '演示项目已建立，任务、里程碑与负责人已关联。'])
    }
    await projects.query('COMMIT')
  } catch (error) { await projects.query('ROLLBACK'); throw error }
  console.log(JSON.stringify({ guest: guest.email, workspaceId: seedWorkspaceId, projects: 3, issues: 21, teamMembers: 4, preservedExistingData: true }))
} finally { await Promise.all([main.end(), projects.end()]) }
