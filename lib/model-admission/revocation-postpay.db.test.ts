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
mock.module(new URL('../abuse/alerts.ts', import.meta.url).href, { namedExports: { checkAbuseAlerts: async () => {} } })

test('a real policy rejection after accounting admission settles zero and leaves the positive balance usable', { skip: !dbUrl }, async t => {
  const pool = new Pool({ connectionString: dbUrl, max: 4 })
  usage = new HostedUsageStore(pool)
  const ownerId=await seedUser(pool,'revocation-postpay')
  const workspace=await seedWorkspace(pool,ownerId,[{userId:ownerId,role:'admin'}])
  await usage.verify(workspace.id,'synthetic-revocation-postpay',`synthetic-${workspace.id}`)
  // Card verification grants nothing now (decision 2026-11-15-1900); an allowance from before still spends.
  await pool.query('INSERT INTO hosted_allowances ("workspaceId",remaining) VALUES ($1,1) ON CONFLICT ("workspaceId") DO UPDATE SET remaining=1',[workspace.id])
  let calls=0
  const server=createServer((_request,response)=>{
    calls++
    response.writeHead(200, { 'content-type': 'application/json', 'x-litellm-call-id': 'fixture-revocation', 'x-litellm-response-cost': '0.000001' }).end(JSON.stringify({
      id: 'fixture-revocation', object: 'chat.completion', created: 1, model: 'mikka-default',
      choices: [{ index: 0, message: { role: 'assistant', content: 'Synthetic receipt' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 1, total_tokens: 1 },
    }))
  })
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{
    afterAdmission=undefined
    server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()))
    await pool.end();await(await import('../db')).pool.end();await(await import('../workspace-db')).workspacePool.end()
  })
  const port=(server.address() as {port:number}).port
  const saved = { url: process.env.MIKKA_LITELLM_URL, key: process.env.MIKKA_LITELLM_MASTER_KEY }
  process.env.MIKKA_LITELLM_URL = `http://127.0.0.1:${port}`
  process.env.MIKKA_LITELLM_MASTER_KEY = 'synthetic-revocation-only'
  t.after(() => {
    for (const [name, value] of [['MIKKA_LITELLM_URL', saved.url], ['MIKKA_LITELLM_MASTER_KEY', saved.key]] as const)
      if (value === undefined) delete process.env[name]; else process.env[name] = value
  })
  const { hostedModel } = await import('../abuse/model')
  const model = await hostedModel(workspace.id, 'mikka-default', undefined, ownerId)
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
