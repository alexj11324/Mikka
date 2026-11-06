import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'

const require = createRequire(resolve(process.env.MIKKA_OPS_DEPENDENCIES, 'package.json'))
const { Pool } = require('pg')
const ORIGIN = 'https://app.aspectlylabs.com'
const BRANCH = 'refs/heads/ops/1515-1517-acceptance'
if (process.env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || process.env.GITHUB_REF !== BRANCH) throw Error('issue_diagnostic_scope_mismatch')
if (!process.env.MIKKA_DATABASE_URL) throw Error('issue_diagnostic_database_unavailable')
const report = { issues: [1515,1516,1517], mode: 'readonly_sql_and_normal_account_reads', normalReadMaintenanceWritesMeasured: false, revision: process.env.GITHUB_SHA, startedAt: new Date().toISOString(), queries: {} }
const pool = new Pool({ connectionString: process.env.MIKKA_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, application_name: 'mikka-1515-1517-readonly' })
let cookie = ''
async function request(path, init = {}) {
  return fetch(ORIGIN + '/mikka' + path, { ...init, headers: { origin: ORIGIN, 'cache-control':'no-store', ...(cookie ? {cookie} : {}), ...init.headers }, redirect:'error', signal:AbortSignal.timeout(30000) })
}
try {
  const version = await request('/api/version')
  const value = await version.json()
  report.production = { status:version.status, build:value.build }
  const db = await pool.connect()
  try {
    await db.query('BEGIN READ ONLY')
    await db.query("SET LOCAL statement_timeout = '20s'")
    const query = async (name, sql) => { report.queries[name] = (await db.query(sql)).rows }
    await query('devices', `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE "removedAt" IS NULL)::int AS visible,
      count(*) FILTER (WHERE id::text LIKE 'de30000%' AND "daemonVersion"='0.9.4' AND "removedAt" IS NULL)::int AS "demoVisible",
      count(*) FILTER (WHERE NOT (id::text LIKE 'de30000%' AND coalesce("daemonVersion",'')='0.9.4') AND "removedAt" IS NULL)::int AS "realVisible",
      count(*) FILTER (WHERE "lastSeenAt">now() AND "removedAt" IS NULL)::int AS "futureVisible" FROM devices`)
    await query('demoRuns', `SELECT r.status, count(*)::int AS count FROM agent_runs r JOIN devices d ON d.id=r."deviceId"
      WHERE d.id::text LIKE 'de30000%' AND d."daemonVersion"='0.9.4' GROUP BY r.status ORDER BY r.status`)
    await query('emptyConnections', `SELECT c.provider,c.state,count(*)::int AS count,count(DISTINCT c."ownerId")::int AS owners
      FROM byos_connections c WHERE c."removedAt" IS NULL AND c."providerSubject" IS NULL AND c."accountLabel" IS NULL
      AND c."secretName" IS NULL AND c."accessSecretName" IS NULL AND c."stagedSecretName" IS NULL AND c."stagedAccessName" IS NULL
      AND c."updatedAt"<now()-interval '1 hour' AND NOT EXISTS (SELECT 1 FROM byos_bindings b WHERE b."connectionId"=c.id)
      GROUP BY c.provider,c.state ORDER BY c.provider,c.state`)
    await query('defaultModels', `SELECT e.harness,e.model,count(*)::int AS entries FROM model_order_entries e JOIN model_order_settings s
      ON e."ownerId"=s."ownerId" AND e."workspaceId"=s."workspaceId" WHERE s.customized=false GROUP BY e.harness,e.model ORDER BY e.harness,e.model`)
    await query('invalidToolParts', `SELECT m."createdAt",m.position,m.message->>'role' AS role,p->>'type' AS type,p->>'toolName' AS "toolName",
      jsonb_typeof(p->'input') AS "inputType", jsonb_typeof(p->'args') AS "argsType",
      p::text LIKE '%NoSuchToolError%' AS "isNoSuchToolError",
      (SELECT count(*)::int FROM coordinator_messages prev WHERE prev."userId"=m."userId" AND prev."botId" IS NOT DISTINCT FROM m."botId" AND prev.position<m.position AND prev.message->>'role'='user') AS "precedingUserMessages"
      FROM coordinator_messages m CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.message->'content')='array' THEN m.message->'content' ELSE '[]'::jsonb END) p
      WHERE m."createdAt">now()-interval '3 days' AND ((p->>'type' IN ('tool-call','tool-result') AND coalesce(p->>'toolName','') IN ('none','')) OR p::text LIKE '%NoSuchToolError%') ORDER BY m."createdAt" DESC LIMIT 30`)
    await db.query('ROLLBACK')
  } finally { db.release() }
  const email=process.env.ACME_DEMO_EMAIL,password=process.env.ACME_DEMO_PASSWORD
  if (!email || !password) report.account={status:'credentials_unavailable'}
  else {
    const login=await request('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})})
    cookie=login.headers.getSetCookie().map(v=>v.split(';',1)[0]).join('; ')
    if(login.status!==200 || !cookie) report.account={status:'sign_in_failed',http:login.status}
    else {
      const response=await request('/api/auth/get-session');const session=await response.json()
      report.account={status:response.status===200 && session?.user?.email?.toLowerCase()===email.toLowerCase()?'verified':'identity_mismatch'}
      if(report.account.status==='verified') {
        const manifestResponse=await request('/renderer-manifest.json'),manifest=await manifestResponse.json()
        if(!manifestResponse.ok || manifest.version!==1 || manifest.target!=='web' || !Array.isArray(manifest.usedActions)) throw Error('published_rpc_manifest_invalid')
        const rpc=async(action,args=[])=>{
          if(!['agents.listDevices','execution-settings.getBotModelMenu'].includes(action)||!manifest.usedActions.includes(action)) throw Error('published_read_action_unavailable')
          const response=await request('/api/rpc',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','x-mikka-rpc':'1'},body:JSON.stringify({version:DESKTOP_RPC_VERSION,action,args:encode(args)})})
          const body=await response.json()
          if(!response.ok || body.version!==DESKTOP_RPC_VERSION || body.ok!==true || !Object.hasOwn(body,'result')) throw Error('published_read_action_failed')
          return decode(body.result)
        }
        const rows=await rpc('agents.listDevices')
        if(!Array.isArray(rows)) throw Error('devices_response_invalid')
        report.account.devices={transport:'web_rpc',count:rows.length,demoPrefixCount:rows.filter(v=>/^de30000/.test(v.id??'')).length,
          futureCount:rows.filter(v=>new Date(v.lastSeenAt).getTime()>Date.now()).length,
          futureOnlineCount:rows.filter(v=>new Date(v.lastSeenAt).getTime()>Date.now()&&v.online===true).length,
          onlineCount:rows.filter(v=>v.online===true).length}
        const botsResponse=await request('/api/bots'),bots=await botsResponse.json()
        if(!botsResponse.ok || !Array.isArray(bots) || !bots.length || bots.some(bot=>bot.ownerId!==session.user.id||bot.workspaceId!==bots[0].workspaceId)) throw Error('account_workspace_unavailable')
        const workspace=bots[0].workspaceId
        const modelResponse=await request('/api/settings/model-order?workspace='+encodeURIComponent(workspace)),order=await modelResponse.json()
        if(!modelResponse.ok || !Array.isArray(order.entries)||!Array.isArray(order.candidates)) throw Error('model_order_response_invalid')
        const summarizeModel=entry=>({harness:entry.harness,model:entry.model,source:entry.source?.kind,block:entry.block?.reason??null})
        report.account.modelOrder={customized:order.customized,autoModelRouting:order.autoModelRouting,preferredHarness:order.preferredHarness,location:order.location,
          cloudReady:order.cloudReady,credentials:order.credentials,entries:order.entries.map(summarizeModel),candidateModels:[...new Set(order.candidates.map(entry=>entry.model))],
          firstKind:order.first?.kind??null,readyDevices:order.readyDeviceIds?.length??null,
          schedulerContractFields:Object.keys(order).filter(key=>/node|schedul|dispatch/i.test(key))}
        const subscriptionsResponse=await request('/api/subscriptions?workspace='+encodeURIComponent(workspace)),subscriptions=await subscriptionsResponse.json()
        if(!subscriptionsResponse.ok||!Array.isArray(subscriptions.connections)) throw Error('subscriptions_response_invalid')
        report.account.subscriptions={enabled:subscriptions.enabled,connections:subscriptions.connections.map(item=>({provider:item.provider,state:item.state,paused:item.paused,
          accountPresent:Boolean(item.account),lastErrorCode:item.lastErrorCode,activeAttemptPresent:Boolean(item.activeAttempt),botCount:item.bots?.length??null}))}
        const menu=await rpc('execution-settings.getBotModelMenu',[null])
        report.account.modelMenu={keys:Object.keys(menu??{}),selected:typeof menu?.selected==='string'?menu.selected.replace(/[a-f0-9]{8}-[a-f0-9-]{27,}/g,'[id]'):null,
          options:Array.isArray(menu?.options)?menu.options.map(item=>({model:item.model,provider:item.provider,kind:item.kind,available:item.available})):null}
      }
    }
  }
  report.status='complete'
} catch(error) {
  report.status='failed'
  report.error={name:error?.name??'Error',code:typeof error?.code==='string'?error.code:/^[a-z_]{1,80}$/.test(error?.message??'')?error.message:'diagnostic_step_failed'}
  process.exitCode=1
} finally {
  await pool.end()
  if(cookie) await request('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).catch(()=>{})
  report.finishedAt=new Date().toISOString()
  mkdirSync('issues-1515-1517-report',{recursive:true})
  writeFileSync('issues-1515-1517-report/preflight.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}
