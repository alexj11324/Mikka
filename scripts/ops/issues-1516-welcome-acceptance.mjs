import { readRendererActions } from '../../lib/renderer-actions.mjs'
import { observeEveSession } from '../acceptance/eve-session.mjs'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { decode, encode } from '../../lib/desktop-rpc/wire.ts'
import { parseOpenUI, isComponent } from '../../lib/openui-lang.ts'
import { detectAgentUISource } from '../../lib/agent-ui-source.ts'
import { createParser } from '@openuidev/react-lang'
import { createAgentLibrary } from '../../lib/agent-ui-catalog.ts'
import { getAgentUIIssue } from '../../lib/agent-ui-status.ts'
import { invalidToolParts } from '../../lib/coordinator/invalid-tool-call.ts'
import { selectTeamWorkspace, isTeamWorkspaceReadPath, publicTeamWorkspaceFailure } from '../acceptance/team-workspace.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const BRANCH = 'refs/heads/ops/1515-1517-acceptance'
const ACTIONS = new Set(['workspace.switchWorkspace', 'bots.createBot', 'agents.stopRun', 'issue-operations.setIssueDeleted', 'issue-operations.getDeletedIssue',
  'execution-settings.getBotModelMenu', 'execution-settings.chooseBotModel',
  'coordinator.welcomeCoordinator', 'coordinator.sendCoordinatorMessage', 'coordinator.syncCoordinatorChat', 'coordinator.stopCoordinatorTurn'])
const cases = [
  ...['a', 'b', 'c', 'd'].map(option => ({ id: 'claude-' + option, model: 'claude-haiku-5-5', provider: 'claude', option })),
  { id: 'codex-d', model: 'gpt-6-luna', provider: 'codex', option: 'd' },
]
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (value, code) => { if (!value) throw Error(code) }
const publicFailure = error => error?.code === 'team_workspace_failed' ? publicTeamWorkspaceFailure(error)
  : ({ name: error?.name ?? 'Error', code: /^[a-z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'acceptance_failed' })
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export function verifySharedSelection(row, scope) {
  check(row && scope.adminId !== scope.ownerId && row.requester === scope.ownerId
    && row.botId === scope.botId && row.workspaceId === scope.workspaceId
    && row.bindingOwner === scope.adminId && row.connectionOwner === scope.adminId
    && row.consumerId === scope.botId && row.bindingWorkspace === scope.workspaceId
    && row.connectionId === scope.connectionId && row.modelId === scope.model && row.provider === scope.provider
    && row.state === 'connected' && row.paused === false && row.removedAt === null
    && Number.isInteger(Number(row.connectionRevision)) && Number(row.connectionRevision) > 0
    && Number(row.connectionRevision) === Number(row.epoch) && UUID.test(row.bindingId ?? '')
    && (scope.provider === 'claude' ? row.route === 'claude_cpa' : ['codex_cpa','openai_siwc'].includes(row.route)), 'shared_binding_unverified')
  return { bindingId: row.bindingId, connectionRevision: Number(row.connectionRevision), route: row.route }
}

const welcomeLibrary = createAgentLibrary()
const welcomeParser = createParser(welcomeLibrary.toJSONSchema(), welcomeLibrary.root)

/** Use the web renderer's schema/parser and issue check, without rendering or executing actions. */
export function welcomeOptions(text) {
  const detected = detectAgentUISource(text)
  const parsed = welcomeParser.parse(detected.source), questions = []
  check(detected.isOpenUI && !getAgentUIIssue(parsed) && parsed.queryStatements.length === 0 && parsed.mutationStatements.length === 0, 'welcome_options_missing')
  const root = parsed.root
  const walk = (value, depth = 0) => {
    if (depth > 25 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return }
    if (value.type === 'element') {
      if (value.typeName === 'BeQuestions') questions.push(...(Array.isArray(value.props.questions) ? value.props.questions : []))
      for (const child of Object.values(value.props)) walk(child, depth + 1)
    }
  }
  walk(root)
  const start = questions.find(question => question?.id === 'start')
  check(start && Array.isArray(start.options) && start.options.length === 4, 'welcome_options_missing')
  const found = new Map(start.options.map(option => [option.value, option]))
  check(['a', 'b', 'c', 'd'].every(key => typeof found.get(key)?.label === 'string' && found.get(key).label.trim() && !found.get(key).action), 'welcome_options_invalid')
  return found
}

export function requestAllowed(path, method, body) {
  if (method === 'GET') return ['/api/version', '/api/auth/get-session', '/api/bots', '/renderer-manifest.json', '/renderer-actions.json'].includes(path)
    || isTeamWorkspaceReadPath('/mikka' + path)
    || /^\/api\/settings\/model-order\?workspace=[a-f0-9-]{36}$/.test(path)
    || /^\/api\/(?:bots|factory\/tasks)\/[a-f0-9-]{36}$/.test(path)
    || /^\/api\/agents\/eve\/v1\/session\/wrun_[A-Za-z0-9_-]+\/stream\?botId=[a-f0-9-]{36}&startIndex=\d{1,9}$/.test(path)
  if (method !== 'POST') return false
  if (/^\/api\/agents\/eve\/v1\/session\?botId=[a-f0-9-]{36}$/.test(path)) return body && Object.keys(body).length === 0
  if (['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path)) return true
  if (/^\/api\/factory\/tasks\/[a-f0-9-]{36}$/.test(path)) return body?.action === 'cancel' && body.binding?.taskId === path.split('/').at(-1)
  if (/^\/api\/threads\/[a-f0-9-]{36}\/machine$/.test(path)) return body?.action === 'end'
  return path === '/api/rpc' && body?.version === 1 && ACTIONS.has(body.action) && Array.isArray(body.args)
}

export async function runAcceptance() {
  check(process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && process.env.GITHUB_REF === BRANCH, 'acceptance_scope_mismatch')
  const applicationSha = process.env.APPLICATION_SHA
  check(/^[a-f0-9]{40}$/.test(applicationSha ?? ''), 'application_sha_required')
  const selection = process.env.ACCEPTANCE_CASES
  check(['claude-d','claude-b','diagnose-b','all'].includes(selection), 'acceptance_cases_invalid')
  const selectedCases = cases.filter(item => selection === 'all' || item.id === selection)
  const email = process.env.SMOKE_OWNER_EMAIL, password = process.env.SMOKE_OWNER_PASSWORD
  check(email && password && process.env.MIKKA_DATABASE_URL, 'acceptance_credentials_required')
  const require = createRequire(resolve(process.env.MIKKA_OPS_DEPENDENCIES, 'package.json'))
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.MIKKA_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, application_name: 'mikka-1516-acceptance-readonly' })
  const report = { issue: 1516, applicationSha, driverRevision: process.env.GITHUB_SHA, startedAt: new Date().toISOString(), cases: [],
    mode: selection === 'diagnose-b' ? 'readonly_original_welcome_shape' : 'welcome_acceptance', transport: 'published_web_rpc_and_real_ndjson_stream', status: 'running', ordinaryAccountSession: false }
  const jar = new Map()
  let published, ownerId, originalWorkspace, teamScope, baseline, baselineAt, baselineBotIds = []
  const fixtures = new Map(), baselineIssueIds = new Set()
  const request = async (path, body, timeout = 30000) => {
    const method = body === undefined ? 'GET' : 'POST'
    check(requestAllowed(path, method, body), 'acceptance_request_denied')
    const response = await fetch(ORIGIN + '/mikka' + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { origin: ORIGIN, 'cache-control': 'no-store', accept: 'application/json',
        ...(jar.size ? { cookie: [...jar].map(([key, value]) => key + '=' + value).join('; ') } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...(path === '/api/rpc' ? { 'x-mikka-rpc': '1' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0], at = pair.indexOf('=')
      if (at > 0) {
        if (/;\s*max-age=0(?:;|$)/i.test(cookie)) jar.delete(pair.slice(0, at))
        else jar.set(pair.slice(0, at), pair.slice(at + 1))
      }
    }
    return response
  }
  const json = async (path, body) => {
    const response = await request(path, body), value = await response.json()
    check(response.ok && value && !value.error, 'acceptance_http_failed')
    return value
  }
  const pin = async () => check((await json('/api/version')).build === applicationSha, 'application_build_changed')
  const teamJson = (path, body) => {
    check(path.startsWith('/mikka/'), 'acceptance_request_denied')
    if (body?.action) check(published?.has(body.action), 'acceptance_action_not_published')
    return json(path.slice('/mikka'.length), body)
  }
  const rpc = async (action, args = [], allowedErrors = []) => {
    check(ACTIONS.has(action) && published?.has(action), 'acceptance_action_not_published')
    const http = await request('/api/rpc', { version: 1, action, args: encode(args) })
    const response = await http.json()
    if (response.version === 1 && response.ok === false && allowedErrors.includes(response.error?.code)) return { error: response.error.code }
    check(http.ok, 'acceptance_http_failed')
    check(response.version === 1 && response.ok === true && Object.hasOwn(response, 'result'), 'acceptance_rpc_failed')
    const value = decode(response.result)
    if (allowedErrors.includes(value?.error)) return value
    if (action === 'issue-operations.getDeletedIssue' && value === null) return null
    check(value && !value.error && value.ok !== false, 'acceptance_action_failed')
    return value
  }
  const readSql = async (sql, args) => {
    const db = await pool.connect()
    try {
      await db.query('BEGIN READ ONLY')
      await db.query("SET LOCAL statement_timeout='15s'")
      return (await db.query(sql, args)).rows
    } finally {
      try { await db.query('ROLLBACK') } finally { db.release() }
    }
  }
  const existingHistory = async () => hash(JSON.stringify(await readSql(`SELECT "botId",position,md5(message::text) AS digest
    FROM coordinator_messages WHERE "userId"=$1 AND "botId"::text=ANY($2::text[]) ORDER BY "botId",position`, [ownerId,baselineBotIds])))
  const existingBots = async () => hash(JSON.stringify(await readSql(`SELECT id,md5(to_jsonb(b)::text) AS digest
    FROM bots b WHERE "ownerId"=$1 AND id::text=ANY($2::text[]) ORDER BY id`,[ownerId,baselineBotIds])))
  const workState = async botId => (await readSql(`SELECT
    (SELECT count(*)::int FROM agent_runs WHERE "userId"=$1 AND "botId"=$2::uuid AND status IN ('queued','preparing','running','paused','waiting_input','finishing')) AS runs,
    (SELECT count(*)::int FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=$2::text AND status='running') AS chats,
    (SELECT count(*)::int FROM coordinator_sessions WHERE "userId"=$1 AND "botId"=$2::uuid AND "leaseHolder" IS NOT NULL AND "leaseUntil">now()) AS leases,
    (SELECT count(*)::int FROM coordinator_events WHERE "userId"=$1 AND "botId"=$2::uuid AND "deliveredAt" IS NULL
      AND (kind='user_message' OR tier IS NULL OR tier<>'background')) AS inbox,
    (SELECT count(*)::int FROM thread_machines WHERE "ownerId"=$1 AND "botId"=$2::uuid AND "workspaceId"=$3
      AND (state<>'ended' OR "workerLeaseId" IS NOT NULL OR "workerLeaseUntil" IS NOT NULL)) AS machines`,[ownerId,botId,teamScope.workspaceId]))[0]
  const settled = state => state && ['runs','chats','leases','inbox','machines'].every(key=>state[key]===0)
  // A Stop acknowledgement resumes a hook; the durable turn still has to close
  // its execution, inbox and lease. This wait is bounded to this test's Bot.
  const waitForCleanup = async (botId, allWork = false) => {
    const deadline=Date.now()+45000
    for(let attempt=0;attempt<30;attempt++){
      const state=await workState(botId),chat=(await rpc('coordinator.syncCoordinatorChat',[botId])).chat
      if(chat?.working===false && (allWork ? settled(state) : state && ['chats','leases','inbox'].every(key=>state[key]===0)))return state
      if(Date.now()>=deadline || attempt===29)break
      await new Promise(resolve=>setTimeout(resolve,1000))
    }
    throw Error('cleanup_active_work_remaining')
  }
  const cleanupBot = async botId => {
    const fixture=fixtures.get(botId)
    check(fixture && UUID.test(botId) && !baselineBotIds.includes(botId), 'cleanup_scope_mismatch')
    const [owned]=await readSql('SELECT id,"ownerId","workspaceId",name,"createdAt" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',[botId,ownerId,teamScope.workspaceId])
    check(owned?.id===botId && owned.ownerId===ownerId && owned.workspaceId===teamScope.workspaceId
      && owned.name===fixture.name && new Date(owned.createdAt).getTime()>=new Date(baselineAt).getTime(),'cleanup_scope_mismatch')
    const cleanup = { bot:'retained_no_delete_api', chatStopped:false, tasksStopped:0, runsStopped:0, machinesEnded:0, machinesAbsent:0,
      issuesDeleted:0, existingIssuesRetained:0, errors:[] }
    const attempt=async(step,work)=>{
      try{return {ok:true,value:await work()}}
      catch(error){cleanup.errors.push({step,...publicFailure(error)});return {ok:false}}
    }
    await attempt('chat_stop',()=>rpc('coordinator.stopCoordinatorTurn',[botId]))
    await attempt('chat_settle',()=>waitForCleanup(botId))
    const listedTasks=await attempt('tasks_read',async()=>{
      const rows=await readSql(`SELECT t.id,t."issueId" FROM factory_tasks t JOIN bots b ON b.id=t."botId"
        WHERE t."userId"=$1 AND t."botId"=$2 AND b."ownerId"=$1 AND b."workspaceId"=$3 ORDER BY t.id LIMIT 32`,[ownerId,botId,teamScope.workspaceId])
      check(rows.length<32,'cleanup_scope_limit');return rows
    })
    const issueIds = new Set(), unsafeIssues = new Set()
    const tasks=listedTasks.value??[]
    for(const task of tasks){
      const stopped=await attempt('task_stop',async()=>{
        check(UUID.test(task.id) && UUID.test(task.issueId),'cleanup_scope_mismatch');issueIds.add(task.issueId)
        for(let revision=0;revision<3;revision++){
          const state=await json('/api/factory/tasks/'+task.id)
          check(state.task?.userId===ownerId && state.task.botId===botId && state.task.issueId===task.issueId,'cleanup_scope_mismatch')
          if(['cancelled','revoked'].includes(state.task.status))break
          const response=await request('/api/factory/tasks/'+task.id,{binding:{taskId:task.id,revision:state.task.revision},eventId:randomUUID(),action:'cancel',reason:'Issue #1516 welcome acceptance cleanup'})
          const value=await response.json()
          check(response.ok && !value?.error || response.status===409 && ['factoryStale','factoryStopped'].includes(value?.error),'cleanup_task_failed')
        }
        check(['cancelled','revoked'].includes((await json('/api/factory/tasks/'+task.id)).task?.status),'cleanup_task_failed')
        cleanup.tasksStopped++
      })
      if(!stopped.ok)unsafeIssues.add(task.issueId)
    }
    const listedRuns=await attempt('runs_read',async()=>{
      const rows=await readSql(`SELECT r.id,r."issueId",r.status,m."runId" IS NOT NULL AS "hasMachine"
        FROM agent_runs r JOIN bots b ON b.id=r."botId"
        LEFT JOIN thread_machines m ON m."runId"=r.id AND m."ownerId"=$1 AND m."workspaceId"=$3
        WHERE r."userId"=$1 AND r."botId"=$2 AND b."ownerId"=$1 AND b."workspaceId"=$3 ORDER BY r.id LIMIT 32`,[ownerId,botId,teamScope.workspaceId])
      check(rows.length<32,'cleanup_scope_limit');return rows
    })
    const runs=listedRuns.value??[], terminal=['succeeded','failed','stopped','cancelled']
    for(const run of runs){
      const stopped=await attempt('run_stop',async()=>{
        check(UUID.test(run.id) && (run.issueId===null || UUID.test(run.issueId)),'cleanup_scope_mismatch')
        if(run.issueId)issueIds.add(run.issueId)
        if(!terminal.includes(run.status)){
          // Stop follows later attempts on the same issue, which may belong to
          // another Bot. Refuse before that mutation if its scope is ambiguous.
          const [scope]=await readSql(`SELECT count(*)::int AS outside FROM agent_runs
            WHERE "userId"=$1 AND "issueId" IS NOT DISTINCT FROM $2::uuid AND "botId" IS DISTINCT FROM $3::uuid
            AND status IN ('queued','preparing','running','paused','waiting_input','finishing')`,[ownerId,run.issueId,botId])
          check(scope?.outside===0,'cleanup_scope_mismatch')
          const result=await rpc('agents.stopRun',[run.id],['runChainEnded'])
          if(result.error){
            const [current]=await readSql('SELECT status FROM agent_runs WHERE id=$1 AND "userId"=$2 AND "botId"=$3',[run.id,ownerId,botId])
            check(current && terminal.includes(current.status),'cleanup_run_failed')
          }else{
            check(Array.isArray(result.stoppedRunIds) && result.stoppedRunIds.every(id=>runs.some(row=>row.id===id)),'cleanup_scope_mismatch')
            cleanup.runsStopped++
          }
        }
      })
      // A failed Stop cannot prevent ending an independently verified machine,
      // or releasing another new run. No-machine local/unqueued runs need no end.
      const ended=await attempt('machine_end',async()=>{
        if(!run.hasMachine){cleanup.machinesAbsent++;return}
        const value=await json('/api/threads/'+run.id+'/machine',{action:'end'})
        check(value.runId===run.id && value.state==='ended','cleanup_machine_failed');cleanup.machinesEnded++
      })
      if(!stopped.ok || !ended.ok)unsafeIssues.add(run.issueId)
    }
    await attempt('chat_stop_after_runs',()=>rpc('coordinator.stopCoordinatorTurn',[botId]))
    const final=await attempt('final_settle',()=>waitForCleanup(botId,true))
    cleanup.chatStopped=final.ok
    for(const id of issueIds){
      if(baselineIssueIds.has(id)){cleanup.existingIssuesRetained++;continue}
      if(!final.ok || unsafeIssues.has(id))continue
      await attempt('issue_delete',async()=>{
        const [issue]=await readSql(`SELECT id,revision,"createdAt",
          (EXISTS(SELECT 1 FROM factory_tasks WHERE "userId"=$2 AND "botId"=$3 AND "issueId"=issues.id)
          OR EXISTS(SELECT 1 FROM agent_runs WHERE "userId"=$2 AND "botId"=$3 AND "issueId"=issues.id)) AS associated
          FROM issues WHERE id=$1 AND "userId"=$2`,[id,ownerId,botId])
        check(issue?.id===id && issue.associated===true
          && new Date(issue.createdAt).getTime()>=new Date(owned.createdAt).getTime(),'cleanup_scope_mismatch')
        const previous=await rpc('issue-operations.getDeletedIssue',[id])
        if(!previous)await rpc('issue-operations.setIssueDeleted',[{id,revision:issue.revision}])
        const deleted=await rpc('issue-operations.getDeletedIssue',[id])
        check(deleted?.id===id && Boolean(deleted.deletedAt),'cleanup_issue_failed');cleanup.issuesDeleted++
      })
    }
    return cleanup
  }
  const streamCursors = new Map()
  const streamTurn = async botId => {
    const cursor = streamCursors.get(botId)
    const start = Date.now()
    const state = { committed: false, badTool: false, error: false, text: '', tools: new Set(), parts: 0 }
    const replyParts = new Map()
    const observed = await observeEveSession({ request: (path, init, timeout) => request(path, init?.body ? JSON.parse(init.body) : undefined, timeout) }, botId, {
      startIndex: cursor?.nextIndex ?? 0, previousSessionId: cursor?.sessionId, timeoutMs: 180000,
      fail: () => check(false, 'turn_stream_unavailable'),
      onEvent: event => {
        state.parts++
        if (event.type === 'call.requested') { const name = event.data.capability?.name; state.tools.add(name); if (!name || name.toLowerCase() === 'none' || event.data.inputError) state.badTool = true }
        if (event.type === 'content.completed' && event.data.kind === 'text' && event.data.phase === 'reply') replyParts.set(event.data.partId, event.data.value)
        if (event.type === 'turn.paused' || event.type === 'session.ended' && event.data.outcome === 'failed') { state.error = true; return true }
        if (event.type === 'turn.settled') {
          state.committed = event.data.outcome === 'completed'; state.error = !state.committed
          state.text = (event.data.reply ?? []).map(partId => replyParts.get(partId) ?? '').join('')
          return true
        }
        return false
      },
    })
    streamCursors.set(botId, observed)
    const chat = (await rpc('coordinator.syncCoordinatorChat', [botId])).chat
    check(chat && Array.isArray(chat.items), 'chat_response_invalid')
    const storedBad = chat.items.some(item => item.tools?.some(tool => !tool || tool.toLowerCase() === 'none') || /NoSuchToolError|AI_NoSuchToolError/.test(JSON.stringify(item)))
    const evidence = { elapsedMs: Date.now() - start, committed: state.committed, working: chat.working, chatErrorPresent: Boolean(chat.error),
      streamError: state.error, invalidToolSeen: state.badTool || storedBad, toolNames: [...state.tools], textChars: state.text.length,
      textSha256: hash(state.text), eveSessionId: observed.sessionId, messages: chat.items.length }
    return { evidence, text: state.text || chat.items.filter(item => item.from === 'coordinator').at(-1)?.text || '' }
  }
  const passTurn = evidence => check(evidence.committed && !evidence.chatErrorPresent && !evidence.streamError && !evidence.invalidToolSeen && evidence.textChars > 0, 'coordinator_turn_failed')
  try {
    await pin()
    await json('/api/auth/sign-in/email', { email, password })
    const session = await json('/api/auth/get-session')
    check(session.user?.email?.toLowerCase() === email.toLowerCase() && session.user?.id, 'acceptance_identity_mismatch')
    ownerId = session.user.id; report.ordinaryAccountSession = true
    const original=await json('/api/workspace')
    check(original.currentUserId===ownerId && UUID.test(original.workspace?.id??''),'original_workspace_unknown')
    originalWorkspace=original.workspace.id
    const manifestResponse = await readRendererActions(request)
    check(manifestResponse.ok, 'acceptance_http_failed')
    const manifest = await manifestResponse.json()
    check(manifest.version === 1 && manifest.target === 'web' && Array.isArray(manifest.usedActions), 'acceptance_manifest_invalid')
    published = new Set(manifest.usedActions)
    check([...ACTIONS].every(action => published.has(action)), 'acceptance_action_not_published')
    report.team=await selectTeamWorkspace({ownerId,json:teamJson,onSelected:value=>{teamScope=value}})
    check(teamScope && UUID.test(teamScope.workspaceId) && teamScope.adminId!==ownerId,'team_scope_unverified')
    const existing=await json('/api/bots')
    check(Array.isArray(existing) && existing.every(bot=>UUID.test(bot.id??'') && bot.ownerId===ownerId && bot.workspaceId===teamScope.workspaceId)
      && new Set(existing.map(bot=>bot.id)).size===existing.length,'team_scope_unverified')
    baselineBotIds=existing.map(bot=>bot.id).sort()
    baselineAt=(await readSql('SELECT clock_timestamp() AS at',[]))[0]?.at
    check(Number.isFinite(new Date(baselineAt).getTime()),'baseline_time_invalid')
    for(const issue of await readSql('SELECT id FROM issues WHERE "userId"=$1',[ownerId]))baselineIssueIds.add(issue.id)
    baseline={history:await existingHistory(),bots:await existingBots()}
    const [active]=await readSql(`SELECT (
      (SELECT count(*) FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=ANY($2::text[]) AND status='running')+
      (SELECT count(*) FROM coordinator_sessions WHERE "userId"=$1 AND "botId"::text=ANY($2::text[]) AND "leaseHolder" IS NOT NULL AND "leaseUntil">now())+
      (SELECT count(*) FROM coordinator_events WHERE "userId"=$1 AND "botId"::text=ANY($2::text[]) AND "deliveredAt" IS NULL
        AND kind='user_message')+
      (SELECT count(*) FROM agent_runs WHERE "userId"=$1 AND "botId"::text=ANY($2::text[]) AND status IN ('queued','preparing','running','paused','waiting_input','finishing'))
      )::int AS n`,[ownerId,baselineBotIds])
    report.existingActiveWork = {total: active.n}
    if (active.n !== 0) report.existingActiveWork.byKind = await readSql(`SELECT 'execution' AS kind,status,count(*)::int AS count FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=ANY($2::text[]) AND status='running' GROUP BY status
      UNION ALL SELECT 'lease','active',count(*)::int FROM coordinator_sessions WHERE "userId"=$1 AND "botId"::text=ANY($2::text[]) AND "leaseHolder" IS NOT NULL AND "leaseUntil">now()
      UNION ALL SELECT 'inbox',kind,count(*)::int FROM coordinator_events WHERE "userId"=$1 AND "botId"::text=ANY($2::text[]) AND "deliveredAt" IS NULL AND kind='user_message' GROUP BY kind
      UNION ALL SELECT 'run',status,count(*)::int FROM agent_runs WHERE "userId"=$1 AND "botId"::text=ANY($2::text[]) AND status IN ('queued','preparing','running','paused','waiting_input','finishing') GROUP BY status`,[ownerId,baselineBotIds])
    check(active.n===0,'shared_account_busy')
    if(selection === 'diagnose-b'){
      const prior=existing.filter(bot=>bot.name==='Issue 1516 acceptance 42371117713-1 claude-b')
      check(prior.length===1 && hash(prior[0].id)==='4a9f4e5aae4a8adee6cbf3a07d6dac69480c3d438093f0b803775a590659d49d','diagnostic_fixture_mismatch')
      const rows=await readSql(`SELECT m.message FROM coordinator_messages m JOIN bots b ON b.id=m."botId"
        WHERE m."userId"=$1 AND m."botId"=$2 AND b."ownerId"=$1 AND b."workspaceId"=$3 AND m.message->>'role'='assistant' ORDER BY m.position`,[ownerId,prior[0].id,teamScope.workspaceId])
      const [{createParser},{createAgentLibrary},{getAgentUIIssue}]=await Promise.all([import('@openuidev/react-lang'),import('../../lib/agent-ui-catalog.ts'),import('../../lib/agent-ui-status.ts')])
      const library=createAgentLibrary(), productionParser=createParser(library.toJSONSchema(),library.root)
      report.originalWelcomeShape=rows.map(row=>{
        const content=row.message?.content
        const text=typeof content==='string'?content:Array.isArray(content)?content.filter(part=>part?.type==='text').map(part=>part.text??'').join(''):''
        const detected=detectAgentUISource(text)
        const shape=value=>{
          const components=[],questions=[]
          const walk=(node,depth=0)=>{
            if(depth>25 || !node || typeof node!=='object')return
            if(Array.isArray(node)){for(const child of node)walk(child,depth+1);return}
            if(isComponent(node)){
              components.push(['Stack','TextContent','BeQuestions'].includes(node.name)?node.name:'other')
              if(node.name==='BeQuestions')for(const q of Array.isArray(node.props.questions)?node.props.questions:[])questions.push({id:q?.id==='start'?'start':'other',options:Array.isArray(q?.options)?q.options.length:0,validValues:Array.isArray(q?.options)?q.options.filter(o=>['a','b','c','d'].includes(o?.value)).length:0})
              for(const child of Object.values(node.props))walk(child,depth+1)
            }
          }
          walk(value);return{parsed:value!==null,components,questions}
        }
        const parsed=productionParser.parse(detected.source), productionQuestions=[]
        const walkProduction=(node,depth=0)=>{
          if(depth>25 || !node || typeof node!=='object')return
          if(Array.isArray(node)){for(const child of node)walkProduction(child,depth+1);return}
          if(node.type==='element'){
            if(node.typeName==='BeQuestions')for(const q of node.props?.questions??[])productionQuestions.push({id:q?.id==='start'?'start':'other',options:q?.options?.length??0,validValues:q?.options?.filter(o=>['a','b','c','d'].includes(o?.value)).length??0})
            for(const child of Object.values(node.props??{}))walkProduction(child,depth+1)
          }
        }
        walkProduction(parsed.root)
        return{production:{hasRoot:Boolean(parsed.root),issuePresent:Boolean(getAgentUIIssue(parsed)),incomplete:parsed.meta.incomplete,unresolved:parsed.meta.unresolved.length,errors:parsed.meta.errors.length,questions:productionQuestions},chars:text.length,sha256:hash(text),matchesFailedStream:hash(text)==='7fa055e80740129680755d4a1c0c88e1928f72e9d5032d3fa827c879e85499e7',detectedAsUI:detected.isOpenUI,raw:shape(parseOpenUI(text)),rendered:shape(parseOpenUI(detected.source))}
      })
      check(report.originalWelcomeShape.length>0,'diagnostic_welcome_missing')
    }
    for (const item of selectedCases) {
      const result = { case: item.id, model: item.model, status: 'running' }
      let botId, selection
      const name = 'Issue 1516 acceptance ' + process.env.GITHUB_RUN_ID + '-' + (process.env.GITHUB_RUN_ATTEMPT??'1') + ' ' + item.id
      try {
        await pin()
        const workspace=await json('/api/workspace')
        check(workspace.currentUserId===ownerId && workspace.workspace?.id===teamScope.workspaceId,'team_workspace_changed')
        const order=await json('/api/settings/model-order?workspace='+teamScope.workspaceId)
        const sources=order.candidates?.filter(candidate=>candidate.source?.kind==='subscription'
          && candidate.credentialOwnerId===teamScope.adminId && candidate.provider===item.provider && candidate.model===item.model)??[]
        check(sources.length===1 && UUID.test(sources[0].source.connectionId),'shared_subscription_source_missing')
        const connectionId=sources[0].source.connectionId
        check(!(await json('/api/bots')).some(bot=>bot.name===name),'acceptance_fixture_exists')
        const created=await rpc('bots.createBot',[{name,color:'gris',shape:'cercle',model:null,repository:null}])
        check(UUID.test(created.id??'') && !baselineBotIds.includes(created.id),'fresh_bot_invalid')
        botId=created.id;result.botHash=hash(botId)
        fixtures.set(botId,{name})
        const bot=await json('/api/bots/'+botId)
        check(bot.id===botId && bot.name===name,'fresh_bot_invalid')
        const [scope]=await readSql('SELECT id,"ownerId","workspaceId",name,"createdAt" FROM bots WHERE id=$1 AND "ownerId"=$2 AND "workspaceId"=$3',[botId,ownerId,teamScope.workspaceId])
        check(scope?.id===botId && scope.ownerId===ownerId && scope.workspaceId===teamScope.workspaceId && scope.name===name
          && new Date(scope.createdAt).getTime()>=new Date(baselineAt).getTime(),'fresh_bot_invalid')
        fixtures.set(botId,{name,createdAt:scope.createdAt})
        const fresh=(await rpc('coordinator.syncCoordinatorChat',[botId])).chat
        check(fresh && fresh.items.length===0 && !fresh.working,'fresh_chat_required')
        const menu = await rpc('execution-settings.getBotModelMenu', [botId])
        const options=menu.groups?.filter(group=>group.kind==='subscription' && group.provider===item.provider && typeof group.owner==='string')
          .flatMap(group=>group.options).filter(option=>option.modelId===item.model && UUID.test(option.id??''))??[]
        check(options.length>0,'shared_subscription_model_missing')
        const eligible=await readSql(`SELECT b.id FROM byos_bindings b JOIN byos_connections c ON c.id=b."connectionId" AND c."ownerId"=b."ownerId"
          WHERE b.id::text=ANY($1::text[]) AND b."ownerId"=$2 AND c.id=$3 AND b."modelId"=$4 AND c.provider=$5
          AND b."connectionRevision"=c.epoch AND c.state='connected' AND c.paused=false AND c."removedAt" IS NULL`,
        [options.map(option=>option.id),teamScope.adminId,connectionId,item.model,item.provider])
        check(eligible.length===1,'shared_subscription_model_ambiguous')
        const option=options.find(option=>option.id===eligible[0].id)
        const picked = await rpc('execution-settings.chooseBotModel', [botId, option.id])
        check(picked.current?.modelId===item.model && picked.current.provider===item.provider && picked.current.kind==='subscription'
          && picked.current.chosen===true && picked.current.availability!=='exhausted' && !picked.current.fallback,'subscription_model_not_selected')
        const [chosen]=await readSql(`SELECT s."ownerId" AS requester,s."botKey" AS "botId",s."workspaceId",b.id AS "bindingId",
          b."ownerId" AS "bindingOwner",b."consumerId",b."workspaceId" AS "bindingWorkspace",b."connectionId",b."connectionRevision",b."modelId",b.route,
          c."ownerId" AS "connectionOwner",c.provider,c.epoch,c.state,c.paused,c."removedAt"
          FROM bot_model_choices s JOIN byos_bindings b ON b.id=s."bindingId" JOIN byos_connections c ON c.id=b."connectionId"
          WHERE s."ownerId"=$1 AND s."workspaceId"=$2 AND s."botKey"=$3`,[ownerId,teamScope.workspaceId,botId])
        selection=verifySharedSelection(chosen,{ownerId,adminId:teamScope.adminId,workspaceId:teamScope.workspaceId,botId,connectionId,model:item.model,provider:item.provider})
        result.sharedSubscriptionSelected=true;result.connectionHash=hash(connectionId)
        check((await rpc('coordinator.welcomeCoordinator', [botId])).queued === true, 'welcome_not_queued')
        const welcome = await streamTurn(botId); result.welcome = welcome.evidence
        passTurn(welcome.evidence)
        check(welcome.evidence.toolNames.length===0,'welcome_business_tool_called')
        const choices=welcomeOptions(welcome.text),label=choices.get(item.option).label
        result.option={value:item.option,labelSha256:hash(label),labelChars:label.length,count:choices.size}
        check((await rpc('coordinator.sendCoordinatorMessage', [label, null, botId, randomUUID()])).queued === true, 'selection_not_queued')
        const answer = await streamTurn(botId); result.answer = answer.evidence
        passTurn(answer.evidence)
        result.executions=await readSql(`SELECT status,snapshot->'runtime'->>'harness' AS harness,snapshot->'runtime'->>'model' AS model,
          snapshot->'runtime'->'modelSelection'->>'type'='subscription' AS subscription,
          snapshot->'runtime'->'modelSelection'->>'ownerId'=$3 AS "sharedOwnerVerified",
          snapshot->'runtime'->'modelSelection'->>'runOwnerId'=$1 AS "requesterVerified",
          snapshot->'runtime'->'modelSelection'->>'consumerId'=$2 AS "consumerVerified",
          snapshot->'runtime'->'modelSelection'->>'workspaceId'=$4 AS "workspaceVerified",
          snapshot->'runtime'->'modelSelection'->>'connectionId'=$5 AS "connectionVerified",
          snapshot->'runtime'->'modelSelection'->>'bindingId'=$6 AS "bindingVerified",
          snapshot->'runtime'->'modelSelection'->>'connectionRevision'=$7 AS "revisionVerified",
          snapshot->'runtime'->'modelSelection'->>'route'=$8 AS "routeVerified"
          FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=$2 ORDER BY started_at`,
        [ownerId,botId,teamScope.adminId,teamScope.workspaceId,connectionId,selection.bindingId,String(selection.connectionRevision),selection.route])
        check(result.executions.length>=2 && result.executions.every(row=>row.status==='completed' && row.harness==='ai_sdk' && row.model===item.model && row.subscription===true
          && ['sharedOwnerVerified','requesterVerified','consumerVerified','workspaceVerified','connectionVerified','bindingVerified','revisionVerified','routeVerified'].every(key=>row[key]===true)),'subscription_execution_unverified')
        const rawMessages = await readSql(`SELECT message FROM coordinator_messages
          WHERE "userId"=$1 AND "botId"=$2 ORDER BY position`, [ownerId, botId])
        const invalidParts = [...invalidToolParts(rawMessages.map(row => row.message))]
        const marked = invalidParts.filter(part => part.mikkaInvalidToolCall === true).length
        // Successful bounded recovery retains host-marked evidence. These are
        // part/call counts, not recovery counts; public and completion gates still apply.
        result.invalidToolEvidence = { parts: invalidParts.length, marked, unmarked: invalidParts.length - marked,
          calls: invalidParts.filter(part => part.type === 'tool-call').length }
        check(result.invalidToolEvidence.unmarked === 0, 'unmarked_invalid_tool_persisted')
        const settled = (await rpc('coordinator.syncCoordinatorChat', [botId])).chat
        result.finalWorking = settled?.working; result.finalChatErrorPresent = Boolean(settled?.error)
        check(settled && !settled.working && !settled.error, 'coordinator_did_not_settle')
        await pin(); result.status = 'passed'
      } catch (error) { result.status = 'failed'; result.error = publicFailure(error) }
      finally {
        if (botId) {
          try{result.cleanup=await cleanupBot(botId);if(result.cleanup.errors.length)result.status='failed'}
          catch(error){result.status='failed';result.cleanupError=publicFailure(error)}
        }
        report.cases.push(result)
        console.log(JSON.stringify({case:result.case,status:result.status,code:result.error?.code??result.cleanupError?.code??null,cleanup:result.cleanup?.chatStopped??!botId}))
      }
    }
    await pin()
    report.status=report.cases.length===selectedCases.length && report.cases.every(item=>item.status==='passed' && item.cleanup?.chatStopped && !item.cleanup.errors.length)?'passed':'failed'
  } catch (error) { report.status = 'failed'; report.error = publicFailure(error) }
  finally {
    report.retainedAcceptanceBots=fixtures.size
    if(fixtures.size){
      try{
        report.finalScopeSettled=report.cases.every(item=>!item.botHash || item.cleanup?.chatStopped && !item.cleanup.errors.length)
        for(const botId of fixtures.keys())if(!settled(await workState(botId)))report.finalScopeSettled=false
        check(report.finalScopeSettled,'cleanup_active_work_remaining')
      }catch(error){report.finalScopeSettled=false;report.status='failed';report.cleanupError=publicFailure(error)}
    }
    if(baseline){
      try{
        report.existingBotsPreserved=await existingBots()===baseline.bots
        report.existingChatHistoryPreserved=await existingHistory()===baseline.history
        check(report.existingBotsPreserved && report.existingChatHistoryPreserved,'existing_account_data_changed')
      }catch(error){report.status='failed';report.preservationError=publicFailure(error)}
    }
    if(jar.size && originalWorkspace && published?.has('workspace.switchWorkspace')){
      report.originalWorkspaceRestored=await rpc('workspace.switchWorkspace',[originalWorkspace])
        .then(async()=>{const current=await json('/api/workspace');return current.currentUserId===ownerId && current.workspace?.id===originalWorkspace},()=>false)
        .catch(()=>false)
      if(!report.originalWorkspaceRestored){report.status='failed';report.cleanupError='workspace_restore_failed'}
    }
    if (jar.size) report.sessionClosed = await request('/api/auth/sign-out', {}).then(response => response.ok, () => false)
    if(!report.sessionClosed){report.status='failed';report.cleanupError??='sign_out_failed'}
    jar.clear()
    try { await pool.end() }
    catch { report.status='failed';report.cleanupError??='database_close_failed' }
    report.finishedAt = new Date().toISOString()
    mkdirSync('issues-1516-welcome-report', { recursive: true })
    writeFileSync('issues-1516-welcome-report/report.json', JSON.stringify(report, null, 2) + '\n')
    console.log(JSON.stringify(report, null, 2))
  }
  if (report.status !== 'passed' || !report.sessionClosed) process.exitCode = 1
  return report
}

if (process.argv.includes('--self-test')) {
  assert.equal(requestAllowed('/api/rpc', 'POST', { version: 1, action: 'agents.removeDevice', args: [] }), false)
  assert.equal(requestAllowed('/api/rpc', 'POST', { version: 1, action: 'coordinator.welcomeCoordinator', args: [] }), true)
  assert.equal(requestAllowed('https://example.com', 'GET'), false)
  assert.equal(requestAllowed('/api/coordinator/stream?botId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&wait=1&after=0','GET'),false)
  assert.equal(requestAllowed('/api/agents/eve/v1/session?botId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','POST',{}),true)
  assert.equal(requestAllowed('/api/agents/eve/v1/session?botId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','POST',{message:'forbidden direct model turn'}),false)
  const text = 'root = Stack([TextContent("Hi"), BeQuestions("Start", [{id:"start", title:"What", options:[{value:"a", label:"A"},{value:"b",label:"B"},{value:"c",label:"C"},{value:"d",label:"D"}], allowCustom:true}])])'
  assert.equal(welcomeOptions(text).get('d').label, 'D')
  assert.equal(welcomeOptions(text.slice(0,-1)).get('b').label,'B','the real web renderer closes a complete card tree with one missing trailing parenthesis')
  assert.throws(() => welcomeOptions('root = globalThis.process.exit(1)'), /welcome_options_missing/)
  assert.throws(() => welcomeOptions(text.replace('{value:"d",label:"D"}', '{value:"c",label:"D"}')),/welcome_options_invalid/)
  assert.equal(welcomeOptions(text.replace('root = ', '')).get('a').label,'A')
  assert.equal(requestAllowed('/api/rpc','POST',{version:1,action:'workspace.createWorkspace',args:[]}),false)
  assert.equal(requestAllowed('/api/rpc','POST',{version:1,action:'workspace-settings.deleteWorkspace',args:[]}),false)
  assert.equal(requestAllowed('/api/workspace','GET'),true)
  assert.equal(requestAllowed('/api/workspace?workspace=not-a-uuid','GET'),false)
  const scope={ownerId:'smoke',adminId:'admin',botId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',workspaceId:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',connectionId:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',provider:'claude',model:'claude-haiku-5-5'}
  const row={requester:scope.ownerId,botId:scope.botId,workspaceId:scope.workspaceId,bindingOwner:scope.adminId,connectionOwner:scope.adminId,
    consumerId:scope.botId,bindingWorkspace:scope.workspaceId,connectionId:scope.connectionId,modelId:scope.model,provider:'claude',
    state:'connected',paused:false,removedAt:null,connectionRevision:2,epoch:2,bindingId:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',route:'claude_cpa'}
  assert.equal(verifySharedSelection(row,scope).bindingId,row.bindingId)
  const forbidden=[{requester:'admin'},{bindingOwner:'smoke'},{connectionOwner:'other'}, {workspaceId:'other'},{bindingWorkspace:'other'},
    {consumerId:'other'},{connectionId:'other'},{modelId:'claude-opus-5-5'},{state:'disconnected'},{paused:true},{removedAt:'now'},
    {epoch:3},{connectionRevision:0},{route:'claude_code_subscription'}]
  for(const change of forbidden)assert.throws(()=>verifySharedSelection({...row,...change},scope),/shared_binding_unverified/)
  assert.throws(()=>verifySharedSelection(row,{...scope,adminId:scope.ownerId}),/shared_binding_unverified/)
  assert.equal(verifySharedSelection({...row,provider:'codex',modelId:'gpt-6-luna',route:'codex_cpa'}, {...scope,provider:'codex',model:'gpt-6-luna'}).route,'codex_cpa')
  console.log('29 acceptance-driver identity, web-parser and request boundary checks passed')
} else await runAcceptance()
