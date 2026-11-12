import { readRendererActions } from '../../lib/renderer-actions.mjs'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { decode, encode, DESKTOP_RPC_VERSION } from '../../lib/desktop-rpc/wire.ts'
import { selectTeamWorkspace, publicTeamWorkspaceFailure } from '../acceptance/team-workspace.mjs'

const require = createRequire(resolve(process.env.MIKKA_OPS_DEPENDENCIES, 'package.json'))
const { Pool } = require('pg')
const ORIGIN = 'https://app.aspectlylabs.com'
const BRANCH = 'refs/heads/ops/1515-1517-acceptance'
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const phase = process.env.PREFLIGHT_PHASE ?? 'after_cleanup'
if (!['before_cleanup', 'after_cleanup'].includes(phase)) throw Error('issue_diagnostic_phase_invalid')
if (process.env.GITHUB_REPOSITORY !== 'alexj11324/Mikka' || process.env.GITHUB_REF !== BRANCH) throw Error('issue_diagnostic_scope_mismatch')
if (!process.env.MIKKA_DATABASE_URL) throw Error('issue_diagnostic_database_unavailable')
const report = { issues: [1515,1516,1517], phase, mode: 'readonly_sql_and_normal_account_reads', normalReadMaintenanceWritesMeasured: false, revision: process.env.GITHUB_SHA, startedAt: new Date().toISOString(), queries: {} }
const pool = new Pool({ connectionString: process.env.MIKKA_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, application_name: 'mikka-1515-1517-readonly' })
let cookie = '', originalWorkspace = null
async function request(path, init = {}) {
  const response = await fetch(ORIGIN + '/mikka' + path, { ...init, headers: { origin: ORIGIN, 'cache-control':'no-store', ...(cookie ? {cookie} : {}), ...init.headers }, redirect:'error', signal:AbortSignal.timeout(30000) })
  const cookies = new Map(cookie.split('; ').filter(Boolean).map(item => [item.slice(0, item.indexOf('=')), item.slice(item.indexOf('=') + 1)]))
  for (const value of response.headers.getSetCookie()) {
    const pair = value.split(';', 1)[0], at = pair.indexOf('=')
    if (at < 1) continue
    if (/;\s*max-age=0(?:;|$)/i.test(value)) cookies.delete(pair.slice(0, at))
    else cookies.set(pair.slice(0, at), pair.slice(at + 1))
  }
  cookie = [...cookies].map(([key, value]) => key + '=' + value).join('; ')
  return response
}
async function teamJson(path, body) {
  if (!path.startsWith('/mikka/')) throw Error('team_path_invalid')
  const response = await request(path.slice('/mikka'.length), body === undefined ? {} : {
    method: 'POST', headers: {'content-type':'application/json', 'x-mikka-rpc':'1'}, body: JSON.stringify(body),
  })
  if (!response.ok) throw Error('team_request_failed')
  return response.json()
}
try {
  const version = await request('/api/version')
  const value = await version.json()
  report.production = { status:version.status, build:value.build }
  if(process.env.APPLICATION_SHA && (!version.ok || value.build!==process.env.APPLICATION_SHA)) throw Error('production_revision_mismatch')
  const db = await pool.connect()
  try {
    await db.query('BEGIN READ ONLY')
    await db.query("SET LOCAL statement_timeout = '20s'")
    const query = async (name, sql) => { report.queries[name] = (await db.query(sql)).rows }
    await query('devices', `SELECT count(*)::int AS total,
      count(*) FILTER (WHERE "removedAt" IS NULL)::int AS visible,
      count(*) FILTER (WHERE id::text LIKE 'de30000%' AND "daemonVersion"='0.9.4' AND kind='local' AND "removedAt" IS NULL)::int AS "demoVisible",
      count(*) FILTER (WHERE NOT (id::text LIKE 'de30000%' AND coalesce("daemonVersion",'')='0.9.4' AND kind='local') AND "removedAt" IS NULL)::int AS "realVisible",
      count(*) FILTER (WHERE "lastSeenAt">now() AND "removedAt" IS NULL)::int AS "futureVisible" FROM devices`)
    await query('demoRuns', `SELECT r.status, count(*)::int AS count FROM agent_runs r JOIN devices d ON d.id=r."deviceId"
      WHERE d.id::text LIKE 'de30000%' AND d."daemonVersion"='0.9.4' AND d.kind='local' GROUP BY r.status ORDER BY r.status`)
    await query('emptyConnections', `SELECT c.provider,c.state,EXISTS(SELECT 1 FROM account_deletion_guards g WHERE g."subjectId"=c."ownerId") AS guarded,count(*)::int AS count,count(DISTINCT c."ownerId")::int AS owners
      FROM byos_connections c WHERE c."removedAt" IS NULL AND c.state='pending'
      AND c."providerSubject" IS NULL AND c."accountLabel" IS NULL
      AND c."secretName" IS NULL AND c."secretDigest" IS NULL AND c."accessSecretName" IS NULL AND c."accessDigest" IS NULL
      AND c."stagedSecretName" IS NULL AND c."stagedDigest" IS NULL AND c."stagedAccessName" IS NULL AND c."stagedAccessDigest" IS NULL
      AND c."updatedAt"<now()-interval '1 hour' AND (c."operationDeadline" IS NULL OR c."operationDeadline"<now())
      AND NOT EXISTS (SELECT 1 FROM byos_bindings b WHERE b."connectionId"=c.id)
      AND NOT EXISTS (SELECT 1 FROM byos_oauth_attempts a WHERE a."connectionId"=c.id AND a."consumedAt" IS NULL AND a."expiresAt">now())
      AND NOT EXISTS (SELECT 1 FROM byos_enrollment_transfers t WHERE t."connectionId"=c.id AND t.epoch=c.epoch AND t."operationId"=c."operationId")
      GROUP BY c.provider,c.state,guarded ORDER BY c.provider,c.state,guarded`)
    await query('defaultModels', `SELECT e.harness,e.model,count(*)::int AS entries FROM model_order_entries e JOIN model_order_settings s
      ON e."ownerId"=s."ownerId" AND e."workspaceId"=s."workspaceId" WHERE s.customized=false GROUP BY e.harness,e.model ORDER BY e.harness,e.model`)
    await query('invalidToolCounts', `SELECT
      CASE WHEN lower(coalesce(p->>'toolName',''))='none' THEN 'none'
        WHEN coalesce(p->>'toolName','')='' THEN 'empty' ELSE 'unknown' END AS category,
      p->>'type' AS type,count(*)::int AS count
      FROM coordinator_messages m CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(m.message->'content')='array' THEN m.message->'content' ELSE '[]'::jsonb END) p
      WHERE m."createdAt">now()-interval '3 days' AND
        ((p->>'type' IN ('tool-call','tool-result') AND coalesce(p->>'toolName','') IN ('none','')) OR p::text LIKE '%NoSuchToolError%')
      GROUP BY category,p->>'type' ORDER BY category,type`)
    await db.query('ROLLBACK')
  } finally { db.release() }
  if(process.env.APPLICATION_SHA && phase==='after_cleanup' && report.queries.emptyConnections.some(row=>row.count>0 && !row.guarded)) throw Error('abandoned_connections_remaining')
  if(process.env.APPLICATION_SHA && phase==='after_cleanup' && report.queries.devices[0]?.demoVisible!==0) throw Error('demo_devices_remaining')
  if(process.env.APPLICATION_SHA && phase==='after_cleanup' && report.queries.demoRuns.some(row=>['queued','preparing','running','paused','waiting_input','finishing'].includes(row.status)&&row.count>0)) throw Error('demo_runs_remaining')
  const email=process.env.SMOKE_OWNER_EMAIL,password=process.env.SMOKE_OWNER_PASSWORD
  if (!email || !password) report.account={status:'credentials_unavailable'}
  else {
    const login=await request('/api/auth/sign-in/email',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email,password})})
    if(login.status!==200 || !cookie) report.account={status:'sign_in_failed',http:login.status}
    else {
      const response=await request('/api/auth/get-session');const session=await response.json()
      report.account={status:response.status===200 && session?.user?.email?.toLowerCase()===email.toLowerCase()?'verified':'identity_mismatch'}
      if(report.account.status==='verified') {
        const manifestResponse=await readRendererActions(request),manifest=await manifestResponse.json()
        if(!manifestResponse.ok || manifest.version!==1 || manifest.target!=='web' || !Array.isArray(manifest.usedActions)) throw Error('published_rpc_manifest_invalid')
        if(!manifest.usedActions.includes('workspace.switchWorkspace')) throw Error('published_workspace_switch_unavailable')
        const before=await teamJson('/mikka/api/workspace')
        if(before?.currentUserId!==session.user.id || !UUID.test(before.workspace?.id??'')) throw Error('account_workspace_unavailable')
        originalWorkspace=before.workspace.id
        let teamScope
        report.account.team=await selectTeamWorkspace({ownerId:session.user.id,json:teamJson,onSelected:value=>{teamScope=value}})
        if(!teamScope || !UUID.test(teamScope.workspaceId??'') || teamScope.adminId===session.user.id) throw Error('team_scope_unverified')
        const selected=await teamJson('/mikka/api/workspace')
        if(selected?.currentUserId!==session.user.id || selected.workspace?.kind!=='team' || selected.workspace.id!==teamScope.workspaceId) throw Error('account_workspace_unavailable')
        const workspace=selected.workspace.id
        const rpc=async(action,args=[])=>{
          if(!['agents.listDevices','execution-settings.getBotModelMenu'].includes(action)||!manifest.usedActions.includes(action)) throw Error('published_read_action_unavailable')
          const response=await request('/api/rpc',{method:'POST',headers:{'content-type':'application/json',accept:'application/json','x-mikka-rpc':'1'},body:JSON.stringify({version:DESKTOP_RPC_VERSION,action,args:encode(args)})})
          const body=await response.json()
          if(!response.ok || body.version!==DESKTOP_RPC_VERSION || body.ok!==true || !Object.hasOwn(body,'result')) throw Error('published_read_action_failed')
          return decode(body.result)
        }
        const rows=await rpc('agents.listDevices')
        if(!Array.isArray(rows)) throw Error('devices_response_invalid')
        report.account.devices={transport:'web_rpc',count:rows.length,demoPrefixCount:rows.filter(v=>(v.id??'').startsWith('de30000')).length,
          futureCount:rows.filter(v=>new Date(v.lastSeenAt).getTime()>Date.now()).length,
          futureOnlineCount:rows.filter(v=>new Date(v.lastSeenAt).getTime()>Date.now()&&v.online===true).length,
          onlineCount:rows.filter(v=>v.online===true).length}
        const botsResponse=await request('/api/bots'),bots=await botsResponse.json()
        if(!botsResponse.ok || !Array.isArray(bots) || bots.some(bot=>bot.ownerId!==session.user.id||bot.workspaceId!==workspace)) throw Error('account_workspace_unavailable')
        const modelResponse=await request('/api/settings/model-order?workspace='+encodeURIComponent(workspace)),order=await modelResponse.json()
        if(!modelResponse.ok || !Array.isArray(order.entries)||!Array.isArray(order.candidates)) throw Error('model_order_response_invalid')
        const summarizeModel=entry=>({harness:entry.harness,model:entry.model,source:entry.source?.kind,block:entry.block?.reason??null})
        report.account.modelOrder={customized:order.customized,entryCount:order.entries.length,autoModelRouting:order.autoModelRouting,preferredHarness:order.preferredHarness,location:order.location,
          cloudReady:order.cloudReady,credentials:order.credentials,entries:order.entries.map(summarizeModel),candidateModels:[...new Set(order.candidates.map(entry=>entry.model))],
          firstKind:order.first?.kind??null,readyDevices:order.readyDeviceIds?.length??null,
          schedulerContractFields:Object.keys(order).filter(key=>/node|schedul|dispatch/i.test(key)),
          dispatchOrder:Array.isArray(order.dispatchOrder)?order.dispatchOrder.map(node=>({type:node.type,order:node.order,availability:node.availability,
            reason:node.reason,excluded:node.excluded,offlineDays:node.offlineDays,presenceReason:node.presenceReason,
            harnesses:node.harnesses.map(item=>({harness:item.harness,installed:item.installed,modelCount:item.models.length})),
            models:node.models.map(item=>({model:item.id,harness:item.harness,available:item.available,reason:item.reason,modelEvidence:item.modelEvidence??null}))})):null}
        const sharedCandidates=order.candidates.filter(item=>item.source?.kind==='subscription' && item.credentialOwnerId===teamScope.adminId)
        report.account.sharedSubscriptions={sources:new Set(sharedCandidates.map(item=>item.source.connectionId)).size,
          models:[...new Set(sharedCandidates.map(item=>item.model))],
          smallModelsPresent:['claude-haiku-5-5','gpt-6-luna'].every(model=>sharedCandidates.some(item=>item.model===model))}
        if(process.env.APPLICATION_SHA) {
          if(report.account.devices.futureOnlineCount!==0) throw Error('device_cleanup_or_presence_failed')
          // Customized test-account preferences remain theirs. The separately
          // authorized read-only personal-workspace check verifies the exact
          // full catalogue and source-derived latest defaults.
          if(!report.account.sharedSubscriptions.smallModelsPresent) throw Error('shared_subscription_models_missing')
          if(!Array.isArray(order.dispatchOrder) || !order.dispatchOrder.length || order.dispatchOrder.some(node=>node.presenceReason==='future_heartbeat'&&(node.order!==null||node.availability==='ready'))) throw Error('dispatch_contract_invalid')
          const ready=order.dispatchOrder.filter(node=>node.order!==null).sort((a,b)=>a.order-b.order)
          if(ready.some((node,index)=>node.order!==index+1) || (order.first?.kind==='cloud'&&ready[0]?.type!=='cloud')) throw Error('dispatch_plan_mismatch')
        }
        const subscriptionsResponse=await request('/api/subscriptions?workspace='+encodeURIComponent(workspace)),subscriptions=await subscriptionsResponse.json()
        if(!subscriptionsResponse.ok||!Array.isArray(subscriptions.connections)) throw Error('subscriptions_response_invalid')
        report.account.subscriptions={enabled:subscriptions.enabled,connections:subscriptions.connections.map(item=>({provider:item.provider,state:item.state,paused:item.paused,
          accountPresent:Boolean(item.account),lastErrorCode:item.lastErrorCode,activeAttemptPresent:Boolean(item.activeAttempt),botCount:item.bots?.length??null}))}
        const menu=await rpc('execution-settings.getBotModelMenu',[null])
        if(menu?.error || !Array.isArray(menu?.groups) || !menu.current) throw Error('model_menu_response_invalid')
        const sharedMenuModels=menu.groups.filter(group=>group.kind==='subscription' && typeof group.owner==='string')
          .flatMap(group=>Array.isArray(group.options)?group.options:[])
        if(process.env.APPLICATION_SHA && ![['claude','claude-haiku-5-5'],['codex','gpt-6-luna']].every(([provider,model])=>
          sharedMenuModels.some(option=>option.provider===provider && option.modelId===model && UUID.test(option.id??'')))) throw Error('shared_model_menu_missing')
        report.account.modelMenu={groupCount:Array.isArray(menu?.groups)?menu.groups.length:null,
          options:Array.isArray(menu?.groups)?menu.groups.flatMap(group=>(group.options??[]).map(item=>({model:item.modelId,harness:item.harness??null,available:item.available??null}))):null}
        const still=await teamJson('/mikka/api/workspace')
        if(still?.currentUserId!==session.user.id || still.workspace?.id!==workspace) throw Error('team_workspace_changed')
      }
    }
  }
  if(process.env.APPLICATION_SHA && report.account?.status!=='verified') throw Error('acceptance_account_unverified')
  report.status='complete'
} catch(error) {
  report.status='failed'
  report.error={name:error?.name??'Error',code:typeof error?.code==='string'?error.code:/^[a-z_]{1,80}$/.test(error?.message??'')?error.message:'diagnostic_step_failed'}
  if(error?.code==='team_workspace_failed') report.error=publicTeamWorkspaceFailure(error)
  process.exitCode=1
} finally {
  try { await pool.end() } catch { report.status='failed';report.cleanupError='database_close_failed';process.exitCode=1 }
  if(cookie && originalWorkspace) {
    try {
      const switched=await teamJson('/mikka/api/rpc',{version:DESKTOP_RPC_VERSION,action:'workspace.switchWorkspace',args:[originalWorkspace]})
      const result=switched?.ok===true?decode(switched.result):null
      const restored=await teamJson('/mikka/api/workspace')
      report.workspaceRestored=result?.ok===true && result.data?.workspaceId===originalWorkspace && restored.workspace?.id===originalWorkspace
      if(!report.workspaceRestored){report.status='failed';report.cleanupError='workspace_restore_failed';process.exitCode=1}
    } catch { report.workspaceRestored=false;report.status='failed';report.cleanupError='workspace_restore_failed';process.exitCode=1 }
  }
  if(cookie) {
    report.sessionClosed=await request('/api/auth/sign-out',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(response=>response.ok,()=>false)
    if(!report.sessionClosed){report.status='failed';report.cleanupError='sign_out_failed';process.exitCode=1}
  }
  report.finishedAt=new Date().toISOString()
  mkdirSync('issues-1515-1517-report',{recursive:true})
  writeFileSync('issues-1515-1517-report/preflight.json',JSON.stringify(report,null,2)+'\n')
  console.log(JSON.stringify(report,null,2))
}
