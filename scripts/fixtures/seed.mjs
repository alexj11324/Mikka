import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { hashPassword, symmetricEncrypt } from 'better-auth/crypto'
import { fixtureDatabase } from './guard.mjs'
import { fixtureScenario, FIXTURE_TIME } from './scenarios.mjs'

const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="16" fill="#4169e1"/><circle cx="32" cy="25" r="10" fill="white"/><path d="M13 57a19 19 0 0 1 38 0" fill="white"/></svg>')}`
const states = ['backlog', 'todo', 'doing', 'review', 'done', 'canceled', 'duplicate']
const titles = ['整理需求', '补充回归测试', '实现验收工作流', '评审 HTTP fake', '完成本地守卫', '取消旧流程', '合并重复需求']

/** Only this script owns these fixed identities. No production auth bypass is installed. */
export async function seedFixture(database, scene, env = process.env) {
  const target = fixtureDatabase(env), fixture = fixtureScenario(scene)
  assert.equal((await database.query('SELECT current_database() AS name')).rows[0].name, target.pathname.slice(1), 'FIXTURE_DATABASE_IDENTITY_MISMATCH')
  const { id, userId, workspaceId, botId } = fixture
  const password = randomBytes(32).toString('base64url'), passwordHash = await hashPassword(password)
  if (!env.BETTER_AUTH_SECRET) throw new Error('FIXTURE_AUTH_SECRET_REQUIRED')
  const githubToken = await symmetricEncrypt({ key: env.BETTER_AUTH_SECRET, data: 'mikka-local-synthetic-user-token' })
  const tx = await database.connect()
  let stage = 'begin'
  const originalQuery = tx.query
  const query = originalQuery.bind(tx)
  tx.query = (...args) => {
    const sql = typeof args[0] === 'string' ? args[0] : args[0]?.text ?? ''
    stage = /^\s*(?:INSERT INTO|SELECT.*?FROM)\s+(["a-zA-Z_]["a-zA-Z_0-9]*)/s.exec(sql)?.[1]?.replaceAll('"', '') ?? stage
    return originalQuery.apply(tx, args)
  }
  try {
    await tx.query('BEGIN')
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ui-fixture:${scene}`])
    const previous = (await tx.query('SELECT email FROM "user" WHERE id=$1', [userId])).rows[0]
    if (previous && previous.email !== fixture.email) throw new Error('FIXTURE_IDENTITY_CONFLICT')
    await tx.query(`INSERT INTO "user" (id,name,email,"emailVerified",image,"createdAt","updatedAt") VALUES ($1,'Fixture Alex',$2,true,$3,$4,$4)
      ON CONFLICT (id) DO UPDATE SET image=EXCLUDED.image`, [userId, fixture.email, avatar, FIXTURE_TIME])
    await tx.query(`INSERT INTO account (id,"accountId","providerId","userId",password,"createdAt","updatedAt") VALUES ($1,$2,'credential',$2,$3,$4,$4)
      ON CONFLICT (id) DO UPDATE SET password=EXCLUDED.password`, [id('credential'), userId, passwordHash, FIXTURE_TIME])
    await tx.query(`INSERT INTO user_onboarding ("userId","completedAt") VALUES ($1,$2) ON CONFLICT DO NOTHING`, [userId, FIXTURE_TIME])
    await tx.query(`INSERT INTO mikka_workspaces (id,"userId",name,slug,kind,"createdAt") VALUES ($1,$2,'Fixture 工作区',$3,'personal',$4) ON CONFLICT DO NOTHING`, [workspaceId, userId, `fixture-${scene}`, FIXTURE_TIME])
    const workspace = (await tx.query('SELECT "userId",kind FROM mikka_workspaces WHERE id=$1', [workspaceId])).rows[0]
    if (workspace?.userId !== userId || workspace.kind !== 'personal') throw new Error('FIXTURE_WORKSPACE_CONFLICT')
    await tx.query(`INSERT INTO mikka_workspace_members ("workspaceId","userId",name,email,role,status,"createdAt") VALUES ($1,$2,'Fixture Alex',$3,'admin','active',$4) ON CONFLICT DO NOTHING`, [workspaceId, userId, fixture.email, FIXTURE_TIME])
    await tx.query(`INSERT INTO setup_checklist_dismissals ("userId","workspaceId","dismissedAt") VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, workspaceId, FIXTURE_TIME])
    await tx.query(`INSERT INTO github_connections ("userId","githubAccountId","githubLogin","accessToken","createdAt","updatedAt") VALUES ($1,'4242','mikka-e2e',$2,$3,$3)
      ON CONFLICT ("userId") DO UPDATE SET "accessToken"=EXCLUDED."accessToken"`, [userId, githubToken, FIXTURE_TIME])
    for (const [index, state] of states.entries()) await tx.query(`INSERT INTO workspace_issue_states (id,workspace_id,icon,color,category,type,is_default,position,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8,$8) ON CONFLICT DO NOTHING`, [id(`state-${state}`), workspaceId, ['dashed','empty','half','progress','check','x','slash'][index], ['gray','gray','blue','purple','green','gray','gray'][index], state, ['done','canceled','duplicate'].includes(state) ? 'closed' : 'open', index * 1000, FIXTURE_TIME])
    await tx.query(`INSERT INTO workspace_issue_states (id,workspace_id,name,icon,color,category,type,is_default,position,created_at,updated_at)
      VALUES ($1,$2,'质量验收','progress','purple','review','open',false,3500,$3,$3) ON CONFLICT DO NOTHING`, [id('state-custom'), workspaceId, FIXTURE_TIME])
    for (const [key, name] of [['coordinator', 'Mikka'], ...(scene === 'empty' ? [] : [['bot', '验收助手']])]) {
      await tx.query(`INSERT INTO bots (id,"ownerId","workspaceId",name,color,shape,model,"publicRole","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,'bleu','cercle','mikka','整理需求、检查实现与验收结果',$5,$5) ON CONFLICT DO NOTHING`, [id(key), userId, workspaceId, name, FIXTURE_TIME])
      await tx.query(`INSERT INTO resource_access_policies (kind,id,"workspaceId","ownerId",visibility,provenance) VALUES ('bot',$1,$2,$3,'private','created') ON CONFLICT DO NOTHING`, [id(key), workspaceId, userId])
    }
    await tx.query(`INSERT INTO coordinator_bots ("ownerId","workspaceId","botId","createdAt") VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [userId, workspaceId, id('coordinator'), FIXTURE_TIME])
    if (scene !== 'empty') {
      for (const [index, state] of [...states, 'custom'].entries()) {
        const issueId = id(`task-${state}`), status = state === 'custom' ? 'review' : state
        const pullRequests = state === 'review' ? [{ url: 'https://github.com/mikka-e2e/core-loop/pull/41', number: 41, title: 'HTTP fake acceptance', state: 'open' }] : []
        const content = { type: 'doc', attrs: { mikka: { number: index + 1, labels: [{ name: '验收工作流', color: 'blue' }], pullRequests,
          subscriberUserIds: [userId], deletedAt: null } }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '固定的本地 fixture 数据，用于检查布局、任务状态、线程和 PR。' }] }] }
        const title = titles[index] ?? '等待质量验收'
        await tx.query(`INSERT INTO issues (id,"userId","workspaceId","ownershipState",scope,"linearSyncPolicy","linearSyncBlocked",title,content,status,state_id,priority,revision,"createdAt","updatedAt")
          VALUES ($1,$2,$3,'bound','personal','disabled',true,$4,$5,$6,$7,$8,1,$9,$9) ON CONFLICT DO NOTHING`,
        [issueId, userId, workspaceId, title, JSON.stringify(content), status, id(`state-${state}`), index === 2 ? 'high' : 'normal', FIXTURE_TIME])
        await tx.query(`INSERT INTO issue_versions (id,"issueId","userId",revision,title,content,status,priority,actor_type,actor_id,"createdAt")
          VALUES ($1,$2,$3,1,$4,$5,$6,$7,'system','local-fixture',$8) ON CONFLICT DO NOTHING`, [id(`version-${state}`), issueId, userId, title, JSON.stringify(content), status, index === 2 ? 'high' : 'normal', FIXTURE_TIME])
      }
      await tx.query(`INSERT INTO agents (id,"userId",harness,name,"createdAt","updatedAt") VALUES ($1,$2,'claude_code','Fixture Agent',$3,$3) ON CONFLICT DO NOTHING`, [id('agent'), userId, FIXTURE_TIME])
      await tx.query(`INSERT INTO agent_runs (id,"userId","workspaceId","issueId","agentId","botId",status,kind,prompt,title,"titleSource","lastReply","lastReplyAt",outcome,"stopReason","startedAt","finishedAt","createdAt","updatedAt")
        VALUES ($1,$2,$3,$4,$5,$6,'succeeded','implement','检查 HTTP fake 的验收结果','HTTP fake 验收','manual','已完成协议与错误路径检查。',$7,'done','submitted',$7,$7,$7,$7) ON CONFLICT DO NOTHING`,
      [id('run'), userId, workspaceId, fixture.taskId, id('agent'), botId, FIXTURE_TIME])
      for (const [index, chunk] of [{ type: 'text-start', id: 'fixture-text' }, { type: 'text-delta', id: 'fixture-text', delta: '已完成协议与错误路径检查。E2B、Slack、GitHub 均使用本地 HTTP fake。' }, { type: 'text-end', id: 'fixture-text' }].entries())
        await tx.query(`INSERT INTO run_chunks (id,"runId",seq,chunk,"createdAt") VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, [id(`chunk-${index}`), id('run'), index + 1, JSON.stringify(chunk), FIXTURE_TIME])
      const publication = { url: 'https://github.com/mikka-e2e/core-loop/pull/41', number: 41, title: 'HTTP fake acceptance', state: 'open', draft: false }
      await tx.query(`INSERT INTO run_publications ("runId","userId","issueId","remoteUrl","remoteKey",branch,"baseBranch",status,"pullRequest","createdAt","updatedAt")
        VALUES ($1,$2,$3,'https://github.com/mikka-e2e/core-loop','v2/github.com/mikka-e2e/core-loop','mikka/http-1','trunk','published',$4,$5,$5) ON CONFLICT DO NOTHING`,
      [id('run'), userId, fixture.taskId, JSON.stringify(publication), FIXTURE_TIME])
      for (const index of [0, 1]) {
        const definition = { title: index ? '每周发布检查' : '检查待验收任务', description: '本地确定性自动化，不触发外部运行。', timezone: 'UTC', timing: { kind: 'manual' },
          task: { kind: 'dispatch_task', botId, prompt: '检查任务并汇总验收结果。', agent: 'claude_code' }, misfire: 'skip', maxLatenessMinutes: 60 }
        await tx.query(`INSERT INTO user_schedules (id,owner_id,workspace_id,bot_id,request_id,request_origin,definition,request_definition,status,visibility,created_at,updated_at)
          VALUES ($1::uuid,$2,$3,$4,$1::text,'page',$5,$5,$6,'owner',$7,$7) ON CONFLICT DO NOTHING`,
        [id(`automation-${index}`), userId, workspaceId, botId, JSON.stringify(definition), index ? 'paused' : 'active', FIXTURE_TIME])
      }
    }
    await tx.query('COMMIT')
  } catch (error) { error.fixtureStage = stage; await query('ROLLBACK'); throw error }
  finally { tx.query = originalQuery; tx.release() }
  return { ...fixture, password }
}
