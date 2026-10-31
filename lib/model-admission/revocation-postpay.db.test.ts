import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mock, test } from 'node:test'
import { Pool } from 'pg'
import { dbUrl, seedUser, seedWorkspace } from '../../tests/support/workspace-admin-db'
import { HostedUsageStore } from '../abuse/store'

let usage: HostedUsageStore
let afterAdmission: (() => Promise<void>) | undefined
mock.module(new URL('../abuse/runtime.ts', import.meta.url).href, { namedExports: {
  canUseMikkaPaid: (workspaceId: string) => usage.canUseMikkaPaid(workspaceId),
  hostedUsage: {
    async reserve(...args: Parameters<HostedUsageStore['reserve']>) { const result=await usage.reserve(...args);await afterAdmission?.();return result },
    settle: (...args: Parameters<HostedUsageStore['settle']>) => usage.settle(...args),
  },
} })
mock.module('ai', { namedExports: { gateway: () => { throw new Error('Only the isolated HTTP fixture is allowed') } } })
mock.module(new URL('../abuse/alerts.ts', import.meta.url).href, { namedExports: { checkAbuseAlerts: async () => {} } })

test('a real policy rejection after accounting admission settles zero and leaves the positive balance usable', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  usage = new HostedUsageStore(pool)
  const ownerId=await seedUser(pool,'revocation-postpay')
  const workspace=await seedWorkspace(pool,ownerId,[{userId:ownerId,role:'admin'}])
  await usage.verify(workspace.id,'synthetic-revocation-postpay',`synthetic-${workspace.id}`)
  await pool.query('UPDATE hosted_allowances SET remaining=1 WHERE "workspaceId"=$1',[workspace.id])
  let calls=0
  const server=createServer((_request,response)=>{
    calls++
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({
      content:[],warnings:[],finishReason:{unified:'stop',raw:'stop'},
      usage:{inputTokens:{total:0},outputTokens:{total:1}},providerMetadata:{gateway:{cost:'0.000001'}},
    }))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{
    afterAdmission=undefined
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
    await pool.end();await(await import('../db')).pool.end();await(await import('../workspace-db')).workspacePool.end()
  })
  const port=(server.address() as {port:number}).port
  const provider={specificationVersion:'v4' as const,provider:'isolated-fixture',modelId:'postpay-revocation-fixture',supportedUrls:{},
    async doGenerate(){return(await fetch(`http://127.0.0.1:${port}`,{method:'POST'})).json()},
    async doStream(){throw new Error('Not used by this case')},
  }
  const {hostedModel}=await import('../abuse/model')
  const model=await hostedModel(workspace.id,provider.modelId,provider,ownerId)
  afterAdmission=async()=>{
    await pool.query(`INSERT INTO workspace_computer_policies("workspaceId",permission,model_admission)
      VALUES($1,'allow',$2) ON CONFLICT("workspaceId") DO UPDATE SET model_admission=EXCLUDED.model_admission`,
    [workspace.id,{schemaVersion:1,revoked:true,routes:[]}])
  }
  await assert.rejects(Promise.resolve(model.doGenerate({prompt:[]})),/modelPolicyRevoked/)
  assert.equal(calls,0)
  const rejected=(await pool.query('SELECT state,"costMicroUsd","reservedFree","reservedPurchased" FROM hosted_usage WHERE "workspaceId"=$1',[workspace.id])).rows[0]
  assert.equal(rejected.state,'settled');assert.equal(Number(rejected.costMicroUsd),0)
  assert.equal(Number(rejected.reservedFree)+Number(rejected.reservedPurchased),0)
  assert.equal((await usage.canUseMikkaPaid(workspace.id)).free,1)
  afterAdmission=undefined
  await pool.query('UPDATE workspace_computer_policies SET model_admission=NULL WHERE "workspaceId"=$1',[workspace.id])
  await model.doGenerate({prompt:[]})
  assert.equal(calls,1)
  assert.equal((await usage.balance(workspace.id)).free,0)
})
