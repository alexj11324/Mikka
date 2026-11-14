import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import test,{mock} from 'node:test'
import { measured } from '../../tests/helpers/read-metrics'
import {disposableDatabase} from '../../tests/helpers/e2e-target.mjs'

const valid=disposableDatabase()&&process.env.E2E_DATABASE_URL===process.env.MIKKA_DATABASE_URL&&process.env.E2E_DATABASE_URL===process.env.DATABASE_URL
if(process.env.REQUIRE_DB==='1'&&!valid)throw new Error('Eve default scope tests require matching isolated loopback _e2e databases')
test('native default Bot uses the authenticated active Workspace and rejects supplied invalid selectors',{skip:!valid},async t=>{
  const aliases=[
    mock.module('next/headers',{namedExports:await import('../../apps/api/compat/headers')}),
    mock.module('next-intl/server',{namedExports:await import('../../apps/api/compat/intl')}),
  ]
  const {pool}=await import('../db')
  const {resolveEveRequestBot}=await import('./auth-bot')
  const {tokenWorkspace}=await import('../tokens/principal')
  const {forgetCoordinatorBots}=await import('../coordinator/coordinator-bot')
  const owner='eve-default-'+randomUUID(),other='eve-default-other-'+randomUUID()
  const personal=randomUUID(),team=randomUUID(),foreign=randomUUID()
  const user={id:owner,name:'Eve default fixture',email:owner+'@example.invalid',image:null}
  const session={user,session:{id:'fixture-auth-session'}}
  const request=(headers:HeadersInit={},query='')=>new Request('https://app.test/eve/v1/session'+query,{headers})
  try {
    for(const id of [owner,other])await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt")VALUES($1,'Eve default fixture',$2,true,now(),now())`,[id,id+'@example.invalid'])
    for(const [id,ownerId,kind]of [[personal,owner,'personal'],[team,owner,'team'],[foreign,other,'team']]){
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name,kind)VALUES($1,$2,\'Eve default fixture\',$3)',[id,ownerId,kind])
      await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role)VALUES($1,$2,\'Owner\',$3,\'admin\')',[id,ownerId,ownerId+'@example.invalid'])
    }
    const home=await resolveEveRequestBot(request(),session)
    assert.ok(home);assert.equal(home.workspaceId,personal)
    const selected=await resolveEveRequestBot(request({'x-mikka-workspace-id':team}),session)
    assert.ok(selected);assert.equal(selected.workspaceId,team);assert.notEqual(selected.botId,home.botId)
    const defaultBot = await measured(() => resolveEveRequestBot(request({cookie:'mikka-workspace='+team}),session))
    const explicitBot = await measured(() => resolveEveRequestBot(request({cookie:'mikka-workspace='+team},'?botId='+selected.botId),session))
    assert.deepEqual(defaultBot.value, selected)
    assert.deepEqual(explicitBot.value, selected)
    assert.equal(defaultBot.statements, explicitBot.statements, 'a warm default Bot selection should resolve the active Workspace only once')
    assert.deepEqual(await resolveEveRequestBot(request({'x-mikka-workspace-id':personal}),session),home)
    const denied:HeadersInit[]=[{'x-mikka-workspace-id':'bad'},{'x-mikka-workspace-id':foreign}]
    for(const headers of denied)assert.equal(await resolveEveRequestBot(request(headers),session),null)
    for(const cookie of ['mikka-workspace=bad','mikka-workspace='+foreign])assert.deepEqual(await resolveEveRequestBot(request({cookie}),session),home)
    for(const query of ['?botId=','?botId=invalid','?botId='+randomUUID()])assert.equal(await resolveEveRequestBot(request({},query),session),null)
    assert.equal(await resolveEveRequestBot(request({'x-mikka-workspace-id':personal},'?botId='+selected.botId),session),null)
    const pat={...session,user:{...user,[tokenWorkspace]:team},tokenWorkspaceId:team}
    assert.deepEqual(await resolveEveRequestBot(request(),pat),selected)
    assert.equal(await resolveEveRequestBot(request({'x-mikka-workspace-id':personal}),pat),null)
    assert.deepEqual(await resolveEveRequestBot(request({cookie:'mikka-workspace='+personal}),pat),selected)
    const { createLegacyPersonalAccessToken } = await import('../tokens/store')
    const { authenticateEveRequest } = await import('./auth')
    const { createRequestDatabaseScope } = await import('../db')
    const { Client } = await import('pg')
    const { token } = await createLegacyPersonalAccessToken(owner, team, { name: 'Eve ingress fixture' })
    const nativeRequest = request({ authorization: 'Bearer ' + token }, '?botId=' + selected.botId)
    const routed = createRequestDatabaseScope(process.env.E2E_DATABASE_URL!)
    try {
      const queries = t.mock.method(Client.prototype, 'query')
      const principal = await routed.run(() => authenticateEveRequest(nativeRequest))
      assert.equal(principal?.principalId, owner)
      assert.equal(principal?.attributes?.workspaceId, team)
      assert.equal(principal?.attributes?.botId, selected.botId)
      const checks = queries.mock.calls.filter(call => /FROM bots WHERE id=\$1 AND "ownerId"=\$2 AND "workspaceId"=\$3/i.test(String(call.arguments[0])))
      assert.equal(checks.length, 1, 'one exact Bot owner and workspace check in human Eve admission')
      queries.mock.restore()
    } finally { await routed.close() }
    await pool.query('UPDATE mikka_workspace_members SET status=\'inactive\' WHERE "workspaceId"=$1 AND "userId"=$2',[team,owner])
    assert.equal(await resolveEveRequestBot(request({'x-mikka-workspace-id':team}),session),null)
    assert.equal(await authenticateEveRequest(nativeRequest),null)
  }finally{
    await pool.query('DELETE FROM bots WHERE "ownerId"=ANY($1::text[])',[[owner,other]])
    await pool.query('DELETE FROM mikka_workspaces WHERE id=ANY($1::uuid[])',[[personal,team,foreign]])
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])',[[owner,other]])
    forgetCoordinatorBots()
    for(const alias of aliases)alias.restore()
  }
})
