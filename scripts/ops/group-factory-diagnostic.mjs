import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, constants, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const TARGET = Object.freeze({
  source: '7b6c1ee1b4a53563b2d6d9885ad992858514cd7a',
  deployment: 'dpl_EJC6ev9gDootduhzSggG6YLd2Udi',
  failedSource: '62bb445860642cb110b37e00794daf06ab454f88',
  failedDeployment: 'dpl_419jqfp1pAwM8QJY2Bt1if7sbH2t',
  coreRunId: '41778455749',
  owner: 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3',
  workspace: '0f877068-66a0-4893-8801-9a14eb3116b3',
  group: 'f197747b-64af-42c3-9ac4-8ff335610324',
  message: '5f255786-5cdd-4f81-82da-00faeee0481d',
  reporter: '55504dd9-0bb0-4dfd-b60d-7e86d8a56f85',
})
const ORIGIN = 'https://app.aspectlylabs.com'
const check = (ok, code) => { if (!ok) throw Error('diagnostic_' + code) }
function eventId(operation) {
  const hex = createHash('sha1').update(JSON.stringify(['mikka-factory-v1', operation, TARGET.message])).digest('hex').slice(0, 32).split('')
  hex[12] = '5'; hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16)
  const s = hex.join('')
  return [s.slice(0, 8), s.slice(8, 12), s.slice(12, 16), s.slice(16, 20), s.slice(20)].join('-')
}
// Identical to the fixed application's pure factoryEventId helper.
export const PARAMETERS = Object.freeze([TARGET.owner, TARGET.workspace, TARGET.group, TARGET.message, TARGET.reporter, eventId('group-intake'), eventId('group-delegate')])
const fixed = `WITH fixed AS (
 SELECT $1::text AS owner, $2::uuid AS workspace, $3::uuid AS conversation,
        $4::uuid AS message, $5::uuid AS reporter, $6::uuid AS intake, $7::uuid AS delegation
), scoped AS (
 SELECT f.* FROM fixed f
 JOIN conversations c ON c.id=f.conversation AND c."workspaceId"=f.workspace AND c."createdBy"=f.owner AND c.kind='group'
 JOIN conversation_messages m ON m.id=f.message AND m."conversationId"=c.id AND m."authorType"='user' AND m."authorId"=f.owner
 JOIN bots b ON b.id=f.reporter AND b."ownerId"=f.owner AND b."workspaceId"=f.workspace
), bound_issues AS (
 SELECT b."issueId" AS id FROM scoped f JOIN group_task_bindings b
   ON b."conversationId"=f.conversation AND b."sourceMessageId"=f.message AND b."userId"=f.owner AND b."reporterId"=f.reporter
 UNION SELECT r."issueId" FROM scoped f JOIN group_task_receipts r
   ON r."messageId"=f.message AND r."conversationId"=f.conversation AND r."userId"=f.owner AND r."reporterId"=f.reporter
 UNION SELECT e."issueId" FROM scoped f JOIN coordinator_events e ON e.id IN (f.intake,f.delegation) AND e."userId"=f.owner
), bound_tasks AS (
 SELECT t.id FROM scoped f JOIN factory_tasks t ON t."userId"=f.owner AND t."botId"=f.reporter AND t."issueId" IN (SELECT id FROM bound_issues)
), bound_runs AS (
 SELECT r.id FROM scoped f JOIN agent_runs r ON r."userId"=f.owner AND r."botId"=f.reporter
 WHERE r."issueId" IN (SELECT id FROM bound_issues)
)
`
export const QUERIES = Object.freeze({
  scope: fixed + `SELECT f.owner AS "ownerId",f.workspace AS "workspaceId",f.conversation AS "conversationId",f.message AS "messageId",f.reporter AS "reporterId",
 t.status,t.error AS "failureCode",t."nextDecisionAt",t."updatedAt",
 t.route->>'action' AS action,t.route->'delegation'->>'operation' AS operation,
 t.route->'delegation'->>'reportTiming' AS "reportTiming",
 jsonb_array_length(COALESCE(t.trace->'decisions','[]'::jsonb)) AS "decisionSteps",
 (t.trace->>'status') AS "traceStatus"
 FROM scoped f JOIN group_turns t ON t."messageId"=f.message AND t."conversationId"=f.conversation AND t."userId"=f.owner LIMIT 1`,
  receipts: fixed + `SELECT r."messageId",r."conversationId",r."userId" AS "ownerId",r."reporterId",r.operation,r."issueId",r."createdAt",
 r.result IS NOT NULL AS "resultPresent",r.result->'taskReceipt'->>'outcome' AS outcome,
 r.result->'taskReceipt'->>'taskId' AS "taskId",r.result->'taskReceipt'->>'runId' AS "runId",
 r.result->'taskReceipt'->>'requestEpoch' AS "requestEpoch"
 FROM scoped f JOIN group_task_receipts r ON r."messageId"=f.message AND r."conversationId"=f.conversation
 AND r."userId"=f.owner AND r."reporterId"=f.reporter LIMIT 1`,
  bindings: fixed + `SELECT b."conversationId",b."issueId",b."userId" AS "ownerId",b."reporterId",b."reporterOwnerId",
 b."executionBotId",b."sourceMessageId",b."sourceEventId",b."lastReportedRevision",b."createdAt"
 FROM scoped f JOIN group_task_bindings b ON b."conversationId"=f.conversation AND b."sourceMessageId"=f.message
 AND b."userId"=f.owner AND b."reporterId"=f.reporter LIMIT 5`,
  sourceEvents: fixed + `SELECT e.id,e."userId" AS "ownerId",e."botId",e."issueId",e.kind,e."createdAt",e."deliveredAt"
 FROM scoped f JOIN coordinator_events e ON e.id IN (f.intake,f.delegation) AND e."userId"=f.owner
 WHERE e.kind='user_message' AND (e."botId" IS NULL OR e."botId"=f.reporter) ORDER BY e."createdAt",e.id LIMIT 2`,
  tasks: fixed + `SELECT t.id,t."userId" AS "ownerId",t."botId",t."issueId",t."sourceEventId",t.stage,t.status,t.revision,
 t."attemptId",t."candidateId",t."createdAt",t."updatedAt"
 FROM scoped f JOIN factory_tasks t ON t.id IN (SELECT id FROM bound_tasks) AND t."userId"=f.owner ORDER BY t."createdAt",t.id LIMIT 10`,
  attempts: fixed + `SELECT a.id,a."taskId",a."runId",a.stage,a.status,a.ordinal,a.position,a.output->>'requestEpoch' AS "requestEpoch",a."createdAt",a."finishedAt"
 FROM factory_attempts a WHERE a."taskId" IN (SELECT id FROM bound_tasks) ORDER BY a."createdAt",a.id LIMIT 30`,
  runs: fixed + `SELECT r.id,r."userId" AS "ownerId",r."botId",r."issueId",r."agentId",r."deviceId",r.kind,r.status,
 r."stopReason",r."stopRequestedAt",r."leaseExpiresAt",r."createdAt",r."startedAt",r."finishedAt",
 d."ownerId" AS "deviceOwnerId",d.kind AS "deviceKind",d.enabled AS "deviceEnabled",d."removedAt" AS "deviceRemovedAt"
 FROM scoped f JOIN agent_runs r ON r.id IN (SELECT id FROM bound_runs) AND r."userId"=f.owner
 LEFT JOIN devices d ON d.id=r."deviceId" AND d."ownerId"=f.owner ORDER BY r."createdAt",r.id LIMIT 30`,
  threadMachines: fixed + `SELECT m."runId",m."ownerId",m."workspaceId",m."botId",m."issueId",m."deviceId",m."sandboxId",
 m.state,m.epoch,m."createdAt",m."endedAt",m."workerLeaseUntil"
 FROM scoped f JOIN thread_machines m ON m."runId" IN (SELECT id FROM bound_runs) AND m."ownerId"=f.owner
 AND m."workspaceId"=f.workspace AND m."botId"=f.reporter ORDER BY m."createdAt",m."runId" LIMIT 30`,
  reporterRuntime: fixed + `SELECT r."ownerId",r."workspaceId",r."botId",r."agentId",r."repoId",r.harness,r."createdAt",
 a."deviceId",d."ownerId" AS "deviceOwnerId",d.kind AS "deviceKind",d.enabled AS "deviceEnabled",
 c.state AS "sharedMachineState",c."sandboxId" AS "sharedSandboxId",c."runtimeReady" AS "sharedRuntimeReady",c."lastActiveAt" AS "sharedLastActiveAt"
 FROM scoped f JOIN bot_cloud_runtimes r ON r."botId"=f.reporter AND r."ownerId"=f.owner AND r."workspaceId"=f.workspace
 LEFT JOIN agents a ON a.id=r."agentId" AND a."userId"=f.owner
 LEFT JOIN devices d ON d.id=a."deviceId" AND d."ownerId"=f.owner
 LEFT JOIN cloud_machines c ON c."ownerId"=f.owner AND c."workspaceId"=f.workspace
 ORDER BY r."createdAt",r."agentId" LIMIT 2`,
})
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value) ? value : null
const idKeys = new Set(['id','workspaceId','conversationId','messageId','reporterId','issueId','taskId','runId','requestEpoch','executionBotId','sourceMessageId','sourceEventId','attemptId','candidateId','botId','agentId','deviceId','repoId'])
const ownerKeys = new Set(['ownerId','reporterOwnerId','deviceOwnerId'])
const boolKeys = new Set(['resultPresent','deviceEnabled','sharedRuntimeReady'])
const countKeys = new Set(['decisionSteps','lastReportedRevision','revision','ordinal','position','epoch'])
const timeKeys = new Set(['createdAt','updatedAt','startedAt','finishedAt','endedAt','deliveredAt','nextDecisionAt','stopRequestedAt','leaseExpiresAt','deviceRemovedAt','workerLeaseUntil','sharedLastActiveAt'])
const choices = {
  status: ['queued','running','complete','failed','pending','passed','blocked','waiting','cancelled','revoked','succeeded','stopped','paused','needs_you'],
  traceStatus: ['running','complete','failed','blocked','stopped'],
  failureCode: ['group_judgment_pending','unknown_mention','generation_timeout','generation_aborted','generation_authentication','generation_rate_limited','generation_upstream','generation_invalid_output','generation_failed_not_replayed','interrupted_generation_not_replayed','stopped'],
  action: ['ignore','observe','reply','clarify','delegate'],operation:['create','continue','status','stop'],reportTiming:['now','on_completion'],
  outcome:['succeeded','blocked','failed','stopped'],stage:['route','intake','plan','execute','review','verify','approval','publish','monitor'],
  kind:['user_message','implement','review','verify','group_chat','chat','computer'],deviceKind:['local','cloud'],
  stopReason:['user','user_requested','cancelled','device_lost','watchdog_exhausted','task_cancelled','approval_required','model_unavailable','epoch_superseded','workspace_access_revoked','policy_changed'],
  state:['starting','running','paused','ended','error'],sharedMachineState:['sleeping','waking','running','error'],harness:['codex','claude_code'],
}
export function projectRow(row) {
  const result = {}
  for (const [key, value] of Object.entries(row)) {
    if (idKeys.has(key)) result[key] = uuid(value)
    else if (ownerKeys.has(key)) { check(value === null || value === TARGET.owner,'owner_mismatch'); result[key] = value }
    else if (boolKeys.has(key)) result[key] = typeof value === 'boolean' ? value : null
    else if (countKeys.has(key)) result[key] = Number.isSafeInteger(value) && value >= 0 ? value : null
    else if (timeKeys.has(key)) result[key] = value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
    else if (key === 'sandboxId' || key === 'sharedSandboxId') result[key] = typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) ? value : null
    else if (choices[key]) result[key] = choices[key].includes(value) ? value : null
  }
  return result
}
const sqlStates = new Set(['42P01','42703','42883','22P02','42501','57014','55P03','53300','08000','08001','08003','08004','08006','08007','08P01','57P01','57P02','57P03'])
const diagnosticCodes = new Set(['workflow_scope_rejected','source_mismatch','configuration_read_unconfirmed','connection_value_rejected','deployment_changed','read_only_not_confirmed','scope_mismatch','owner_mismatch','row_limit'])
export async function runGroupFactoryDiagnostic({ env = process.env, createClient, verifySource, verifyVersion, now = Date.now } = {}) {
  const report = { schemaVersion:1, status:'failed', evidenceKind:'fixed-production-read-only-database-diagnostic',
    observedAt:new Date(now()).toISOString(), target:TARGET, configurationSource:{environment:'prod',path:'/vercel',name:'MIKKA_DATABASE_URL',directlyObservedDeployedValue:false},
    providerInvoked:false, applicationSessionOpened:false, sqlWritesPerformed:false, normalApiCleanupPerformed:false,
    sharedMachineOwnershipDoesNotProveFixtureCreation:true, readOnlyConfirmed:false, connectionClosed:false, completedQueries:[], observations:{}, error:null, sqlState:null }
  let client, phase = 'preflight', begun = false
  try {
    check(env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REF === 'refs/heads/acceptance/proactive-1157-1163' && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_RUN_ATTEMPT === '1','workflow_scope_rejected')
    check(env.DIAGNOSTIC_SOURCE_SHA === TARGET.source && await verifySource() === TARGET.source,'source_mismatch')
    await verifyVersion()
    check(env.DIAGNOSTIC_SECRET_READ === 'success','configuration_read_unconfirmed')
    let url
    try { url = new URL(env.MIKKA_DATABASE_URL) } catch { check(false,'connection_value_rejected') }
    check(['postgres:','postgresql:'].includes(url.protocol) && url.hostname.endsWith('.neon.tech') && /^ep-[a-z0-9-]+$/.test(url.hostname.split('.')[0]),'connection_value_rejected')
    phase = 'connect'
    client = await createClient({ connectionString:env.MIKKA_DATABASE_URL, connectionTimeoutMillis:10000, query_timeout:11000, statement_timeout:10000, application_name:'mikka-fixed-group-factory-diagnostic' })
    delete env.MIKKA_DATABASE_URL
    client.on?.('error', () => {})
    await client.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'); begun = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    await client.query("SET LOCAL lock_timeout = '5s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '30s'")
    const readOnly = await client.query("SELECT current_setting('transaction_read_only') AS readonly")
    check(readOnly.rows[0]?.readonly === 'on','read_only_not_confirmed'); report.readOnlyConfirmed = true
    for (const [name, sql] of Object.entries(QUERIES)) {
      phase = name
      const result = await client.query(sql, [...PARAMETERS])
      check(Array.isArray(result.rows) && result.rows.length <= (['scope','receipts'].includes(name) ? 1 : ['sourceEvents','reporterRuntime'].includes(name) ? 2 : name === 'bindings' ? 5 : name === 'tasks' ? 10 : 30),'row_limit')
      if (name === 'scope') check(result.rows.length === 1,'scope_mismatch')
      report.observations[name] = result.rows.map(projectRow)
      report.completedQueries.push(name)
    }
    phase = 'rollback'
    await client.query('ROLLBACK'); begun = false
    await verifyVersion()
    report.status = 'observed'
  } catch (error) {
    const code = String(error?.message ?? '').replace(/^diagnostic_/, '')
    report.error = diagnosticCodes.has(code) ? 'diagnostic_' + code : 'diagnostic_failed'
    report.sqlState = sqlStates.has(error?.code) ? error.code : null
    report.failedPhase = phase
  } finally {
    delete env.MIKKA_DATABASE_URL
    if (client) {
      if (begun) { try { await client.query('ROLLBACK') } catch {} }
      try { await client.end(); report.connectionClosed = true } catch {}
    }
  }
  if (client && !report.connectionClosed) report.status = 'failed'
  report.finishedAt = new Date(now()).toISOString()
  return report
}
function writePrivate(path, data) {
  mkdirSync(dirname(path), { recursive:true, mode:0o700 })
  const fd = openSync(path, constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600)
  try { writeFileSync(fd,JSON.stringify(data,null,2)+'\n') } finally { closeSync(fd) }
}
async function main() {
  const output = resolve(process.env.DIAGNOSTIC_OUTPUT ?? 'group-factory-diagnostic/results.json')
  writePrivate(output+'.started',{startedAt:new Date().toISOString(),target:TARGET})
  const verifySource = async () => {
    check(!execFileSync('git',['status','--porcelain','--untracked-files=no'],{encoding:'utf8'}).trim(),'source_mismatch')
    return execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()
  }
  const verifyVersion = async () => {
    const response = await fetch(ORIGIN+'/mikka/api/version',{redirect:'error',signal:AbortSignal.timeout(15000),headers:{'cache-control':'no-store'}})
    const body = await response.json().catch(() => null)
    check(response.ok && body?.build === TARGET.deployment,'deployment_changed')
  }
  const require = createRequire(resolve('package.json'))
  const report = await runGroupFactoryDiagnostic({verifySource,verifyVersion,createClient:options => new (require('pg').Client)(options)})
  writePrivate(output,report)
  console.log(JSON.stringify({status:report.status,completedQueries:report.completedQueries,error:report.error,sqlState:report.sqlState,connectionClosed:report.connectionClosed}))
  if (report.status !== 'observed') process.exitCode = 1
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => {
  delete process.env.MIKKA_DATABASE_URL
  console.error('diagnostic_process_failed');process.exitCode=1
})

