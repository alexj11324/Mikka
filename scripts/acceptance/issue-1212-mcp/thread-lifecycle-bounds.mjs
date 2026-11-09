// The existing Actions branch calls the exact released lifecycle driver exports.
// Its own push/source guard applies; no GitHub identity or main event is forged.
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configuration } from './mcp-reply-production.mjs'

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const SHA = /^[a-f0-9]{40}$/
const need = (value, code) => { if (!value) throw Error('lifecycle_bounds_' + code) }
const sha = value => createHash('sha256').update(value).digest('hex')

export function assertRuntimePin(current, expected, templateId) {
  for (const value of [current, expected]) {
    need(SHA.test(value?.sourceCommit ?? '') && SHA.test(value?.workerSha ?? ''), 'approved_runtime_invalid')
    need(['desktop','claude','codex'].every(kind => /^[A-Za-z0-9_-]{1,100}$/.test(value.templates?.[kind] ?? '')), 'approved_runtime_invalid')
  }
  need(current.sourceCommit === expected.sourceCommit && current.workerSha === expected.workerSha
    && ['desktop','claude','codex'].every(kind => current.templates[kind] === expected.templates[kind]), 'approved_runtime_changed')
  if (templateId !== undefined) need(Object.values(expected.templates).includes(templateId), 'unapproved_runtime_template')
  return { sourceCommit: expected.sourceCommit, workerSha: expected.workerSha,
    templateMatched: templateId === undefined ? null : true }
}

export function activeCommand(caseId, sourceCommit, phase = 'work') {
  need(UUID.test(caseId) && SHA.test(sourceCommit) && ['work','margin'].includes(phase), 'command_scope')
  const seconds = phase === 'work' ? 160 : 30
  return `python3 - <<'MIKKA_1593_ACTIVE_PY'\nimport json,time\ncase_id=${JSON.stringify(caseId)}\nsource=${JSON.stringify(sourceCommit)}\nphase=${JSON.stringify(phase)}\nstart=time.time_ns()//1000000\nclock=time.monotonic_ns()\ntime.sleep(${seconds})\nvalue=dict(caseId=case_id,sourceCommit=source,phase=phase,elapsedMs=(time.monotonic_ns()-clock)//1000000,wallMs=time.time_ns()//1000000-start)\nprint('MIKKA_1593_ACTIVE '+json.dumps(value,separators=(',',':')))\nMIKKA_1593_ACTIVE_PY`
}

const toolText = value => typeof value === 'string' ? value
  : value?.exitCode === 0 && typeof value.output === 'string' ? value.output
    : Array.isArray(value) ? value.filter(row => row?.type === 'text').map(row => row.text).join('\n') : null

export function activeToolProof(detail, { caseId, sourceCommit, runId, phase = 'work' }, exactCommand) {
  const inputs = new Map(), results = []
  for (const row of detail.chunks ?? []) {
    const c = row.chunk, id = c?.toolCallId
    if (typeof id !== 'string' || id.length > 500 || UUID.test(id.slice(0,36)) && id[36] === ':' && !id.startsWith(runId + ':')) continue
    if (c.type === 'tool-input-available' && ['bash','shell'].includes(c.toolName?.toLowerCase())
      && exactCommand(c.input?.command, activeCommand(caseId, sourceCommit, phase))) inputs.set(id, row)
    if (c.type === 'tool-output-available' && inputs.has(id)) {
      const output = toolText(c.output)
      if (!output || output.length > 4096) continue
      for (const line of output.split('\n').filter(line => line.startsWith('MIKKA_1593_ACTIVE '))) {
        let value
        try { value = JSON.parse(line.slice('MIKKA_1593_ACTIVE '.length)) } catch { continue }
        need(value.caseId === caseId && value.sourceCommit === sourceCommit && value.phase === phase
          && Number.isSafeInteger(value.elapsedMs) && value.elapsedMs >= (phase === 'work' ? 155000 : 25000) && value.elapsedMs <= (phase === 'work' ? 240000 : 60000)
          && Number.isSafeInteger(value.wallMs) && Math.abs(value.wallMs - value.elapsedMs) < 5000, 'active_receipt')
        results.push({ elapsedMs: value.elapsedMs, wallMs: value.wallMs, toolCallHash: sha(id).slice(0,16), commandSha256: sha(activeCommand(caseId,sourceCommit,phase)) })
      }
    }
  }
  need(inputs.size <= 1 && results.length <= 1, 'duplicate_active_tool')
  return { started: inputs.size === 1, completed: results.length === 1, receipt: results[0] ?? null }
}

export function terminalPauseBound(terminal, provider) {
  const finished = Date.parse(terminal?.finishedAt ?? ''), observed = Date.parse(provider?.observedAt ?? '')
  need(Number.isFinite(finished) && Number.isFinite(observed) && provider?.status === 'observed'
    && provider.state === 'paused' && provider.ownershipVerified === true, 'terminal_pause_observation')
  const elapsedUpperBoundMs = observed - finished
  need(elapsedUpperBoundMs >= 0 && elapsedUpperBoundMs <= 60000, 'terminal_pause_limit')
  return { finishedAt: terminal.finishedAt, pausedObservedAt: provider.observedAt, elapsedUpperBoundMs,
    clock: 'server_finished_at_and_driver_utc_observation', exactProviderTransition: false }
}

export async function runLifecycleBounds(env, event, { signal } = {}) {
  const binding = configuration(env, event), source = resolve(env.MIKKA_RELEASE_SOURCE)
  need(source.startsWith(resolve(env.GITHUB_WORKSPACE) + '/'), 'source_directory')
  const lifecycle = await import(pathToFileURL(source + '/scripts/acceptance/thread-lifecycle.mjs'))
  const { watchRun, observeChunks, hasStartupInitialization } = await import(pathToFileURL(source + '/scripts/acceptance/cloud-startup.mjs'))
  const requireSource=createRequire(source+'/package.json')
  const { Pool } = requireSource('pg')
  const { Sandbox } = await import(pathToFileURL(requireSource.resolve('e2b')))
  const runtimeReader=(await import(pathToFileURL(source+'/scripts/acceptance/cloud-startup.mjs'))).readProductionWorkerRelease
  const approved=JSON.parse(await readFile('issue-1212-mcp-report/runtime-pin.json','utf8'))
  need(approved.applicationSha===binding.applicationSha && Number.isSafeInteger(approved.runId) && approved.runId>0
    && Array.isArray(approved.verifiedJobs) && approved.verifiedJobs.length===7,'approved_runtime_invalid')
  const runtime=approved.configuration, runtimeObservations=[]
  assertRuntimePin(await runtimeReader({token:env.VERCEL_TEAM_TOKEN}),runtime)
  const getInfo=async(...args)=>{
    const info=await Sandbox.getInfo(...args)
    need(typeof info.templateId==='string','unapproved_runtime_template')
    runtimeObservations.push({...assertRuntimePin(runtime,runtime,info.templateId),sandboxHash:sha(info.sandboxId).slice(0,16)})
    return info
  }
  const target = new URL(env.DATABASE_URL)
  need(['postgres:', 'postgresql:'].includes(target.protocol) && target.hostname.endsWith('.neon.tech')
    && target.pathname === '/orvilo_mvp' && (!target.port || target.port === '5432') && !target.hash, 'database_target')
  const pool = new Pool({ connectionString: target.href, max: 1, statement_timeout: 15000, query_timeout: 20000,
    connectionTimeoutMillis: 5000, options: '-c default_transaction_read_only=on', application_name: 'mikka-owned-lifecycle-bounds' })
  const bounds = []
  async function oneCase(args) {
    const caseId = randomUUID(), receipt = { harness: args.harness, caseId, status: 'failed', databaseSnapshots: 0,
      startup: { limitMs: 60000, clock: 'driver_monotonic_observation_upper_bound', underFiveSecondTargetAsserted:false }, leases: {}, endRequests: [] }
    bounds.push(receipt)
    let originRunId, dispatchedAt, initialTokenId
    const client = { ...args.client,
      async rpc(action, values, extra) {
        if (action === 'issues.saveIssue') {
          values = structuredClone(values)
          const text = values[0]?.content?.content?.[0]?.content?.[0]
          need(text?.type === 'text' && text.text.includes(caseId), 'task_scope')
          text.text += '\n\nAdditional active-lease acceptance: before the first before_question snapshot and before ask_human, execute the following exact shell command ONCE, in its own native shell tool call with a 240000ms timeout. It waits for 160 seconds without network, credential reads, file writes or server queries; leave the command running until it returns. Do not repeat it after Owner resume. This is real active execution, not a polling loop.\n\n' + activeCommand(caseId, args.sourceCommit)
            + '\n\nImmediately after that command, execute this second exact command separately with a 60000ms timeout. Its 30-second observation margin keeps the run active while the driver takes its single event-triggered lease snapshot; it does not poll or read the server. After both commands finish, continue the original before_question snapshot and genuine Owner decision task.\n\n' + activeCommand(caseId,args.sourceCommit,'margin')
        }
        return args.client.rpc(action, values, extra)
      },
      async json(path, init, timeout) {
        const ends = /^\/api\/threads\/[a-f0-9-]{36}\/machine$/.test(path) && init?.method === 'POST' && JSON.parse(init.body).action === 'end'
        const cancels = /^\/api\/factory\/tasks\/[a-f0-9-]{36}$/.test(path) && init?.method === 'POST' && JSON.parse(init.body).action === 'cancel'
        const request = ends || cancels ? { requestedAt: new Date().toISOString(), clock: 'driver_monotonic_elapsed' } : null
        const began = performance.now()
        if (/\/computer\/runs$/.test(path) && init?.method === 'POST') dispatchedAt = performance.now()
        const value = await args.client.json(path, init, timeout)
        if (/\/computer\/runs$/.test(path) && init?.method === 'POST') originRunId = value.runId
        if (request) {
          Object.assign(request,{ acknowledgedAt:new Date().toISOString(),elapsedMs:Math.ceil(performance.now()-began) })
          if (ends) receipt.endRequests.push({...request,runId:value.runId,state:value.state})
          if (cancels) receipt.factoryCancellation=request
        }
        return value
      },
    }
    async function lease(label, runId) {
      const result = await pool.query(`SELECT id::text,status,"leaseExpiresAt"::text AS expiry,
        "leaseExpiresAt">clock_timestamp() AS live,"deviceTokenId"::text AS token,
        EXISTS(SELECT 1 FROM run_tokens t WHERE t."runId"=r.id AND t."userId"=$2
          AND t."revokedAt" IS NULL AND t."expiresAt">now()) AS run_token_live
        FROM agent_runs r WHERE id=$1 AND "userId"=$2 AND "botId"=$3`, [runId,args.scope.ownerId,args.botId])
      receipt.databaseSnapshots++; need(result.rowCount === 1, 'lease_scope')
      const row = result.rows[0]; if (label === 'before') initialTokenId = row.token
      receipt.leases[label] = { live: row.live === true, runTokenLive:row.run_token_live===true, expiresAt: row.expiry, status: row.status === 'running' ? 'running' : 'other' }
    }
    const wait = async (c, record, timeout, WebSocketImpl, now, legacy, hooks) => {
      const telemetry = { runId: record.runId, runIdHash: sha(record.runId).slice(0,16), harness: args.harness }
      return watchRun(c, record, timeout, WebSocketImpl, now, legacy, { ...hooks, observe: async (detail, active) => {
        if (record.runId === originRunId) {
          observeChunks(telemetry, detail, Date.now())
          if (telemetry.agentStart && !receipt.startup.observedUpperBoundMs) receipt.startup.observedUpperBoundMs = Math.ceil(performance.now() - dispatchedAt)
          // These values passed the released driver's bounded phase parser.
          // Keep the native initialization timing separate from the HTTP/live
          // observation upper bound; that bound cannot prove a <5s target.
          receipt.startup.nativeInitialization = {
            proved:hasStartupInitialization(telemetry),
            daemonMs:telemetry.daemonStartupTiming?.ms ?? null,
            preparationMs:telemetry.daemonPreparationTiming?.ms ?? null,
            phases:telemetry.daemonStartupTiming?.phases ?? [],
          }
          const proof = activeToolProof(detail, { caseId, sourceCommit: args.sourceCommit, runId: originRunId }, lifecycle.isExactNativeCommand)
          if (proof.started && !receipt.leases.before) await lease('before', originRunId)
          if (proof.completed && !receipt.leases.after) { await lease('after', originRunId); receipt.activeCommand = proof.receipt }
          const margin = activeToolProof(detail, { caseId, sourceCommit: args.sourceCommit, runId: originRunId, phase: 'margin' }, lifecycle.isExactNativeCommand)
          if (margin.completed) receipt.observationMargin = margin.receipt
        }
        return hooks.observe(detail, active)
      } })
    }
    const result = await lifecycle.runLifecycleCase({ ...args, client, caseId, wait })
    try {
      need(receipt.activeCommand && receipt.observationMargin && UUID.test(initialTokenId ?? '') && receipt.leases.before?.live && receipt.leases.after?.live
        && receipt.leases.before.runTokenLive && receipt.leases.after.runTokenLive
        && Date.parse(receipt.leases.after.expiresAt) > Date.parse(receipt.leases.before.expiresAt), 'lease_renewal_missing')
      need(receipt.startup.observedUpperBoundMs > 0 && receipt.startup.observedUpperBoundMs <= receipt.startup.limitMs, 'startup_limit')
      receipt.normalRunExit = { kind: 'native_question_safe_exit', origin: result.terminal?.origin,
        continuation: result.terminal?.continuation, providerPausedBeforeAnswer: result.provider?.before_answer?.state === 'paused',
        providerPausedAfterDelivery: result.provider?.after_delivery?.state === 'paused' }
      need(result.terminal?.origin?.finishedAt && result.terminal?.continuation?.finishedAt
        && receipt.normalRunExit.providerPausedBeforeAnswer && receipt.normalRunExit.providerPausedAfterDelivery, 'terminal_pause_missing')
      receipt.normalRunExit.pauseObservedUpperBounds = {
        origin: terminalPauseBound(result.terminal.origin,result.provider.before_answer),
        continuation: terminalPauseBound(result.terminal.continuation,result.provider.after_delivery),
      }
      const ids = [result.runId,result.continuationRunId]
      need(ids.every(id=>UUID.test(id)) && result.cleanup?.status === 'passed'
        && receipt.factoryCancellation && ids.every(id=>receipt.endRequests.some(row=>row.runId===id&&row.state==='ended'&&row.elapsedMs<=120000))
        && ids.every(id=>result.cleanup.machineReceipts?.some(row=>row.runId===id&&row.state==='ended')), 'cancel_end_missing')
      const providerEnd = result.cleanup.provider
      need(providerEnd?.status === 'observed' && providerEnd.state === 'missing' && providerEnd.ownershipVerified === true, 'provider_end_unconfirmed')
      const cancelToProviderMissingUpperBoundMs = Date.parse(providerEnd.observedAt) - Date.parse(receipt.factoryCancellation.requestedAt)
      need(Number.isFinite(cancelToProviderMissingUpperBoundMs) && cancelToProviderMissingUpperBoundMs >= 0
        && cancelToProviderMissingUpperBoundMs <= 120000, 'cancel_provider_end_limit')
      const tokens = await pool.query(`SELECT count(*)::int AS runs,
        COALESCE(bool_and(r.status IN ('succeeded','completed','failed','stopped','cancelled')),false) AS terminal,
        NOT EXISTS(SELECT 1 FROM run_tokens t JOIN agent_runs r2 ON r2.id=t."runId"
          WHERE r2.id=ANY($1::uuid[]) AND r2."userId"=$2 AND t."revokedAt" IS NULL AND t."expiresAt">now()) AS run_tokens_invalid,
        NOT EXISTS(SELECT 1 FROM device_tokens t WHERE t.id=$4::uuid AND t."userId"=$2 AND t."revokedAt" IS NULL
          AND (t."expiresAt" IS NULL OR t."expiresAt">now())) AS initial_device_token_invalid
        FROM agent_runs r WHERE r.id=ANY($1::uuid[]) AND r."userId"=$2 AND r."botId"=$3`, [ids,args.scope.ownerId,args.botId,initialTokenId])
      receipt.databaseSnapshots++; const row=tokens.rows[0]
      need(row.runs===2 && row.terminal && row.run_tokens_invalid && row.initial_device_token_invalid, 'token_invalidation_missing')
      receipt.cancelEnd = { ownerEndReceipts: result.cleanup.machineReceipts, runTokensInvalid: true, initialDeviceTokenInvalid: true,
        providerMissingConfirmed: true, cancelToProviderMissingUpperBoundMs, exactProviderTransition: false }
      receipt.status = 'passed'
    } catch (error) { receipt.code = /^lifecycle_bounds_[a-z_]+$/.test(error?.message??'') ? error.message : 'lifecycle_bounds_failed' }
    result.additionalBounds = receipt
    return result
  }
  let report
  try {
    report = await lifecycle.runThreadLifecycle({ sourceCommit: binding.applicationSha, timeoutMs: 420000,
      reportPath: resolve(env.RUNNER_TEMP,'thread-lifecycle-bounds/report.json') }, { env, signal, runCase: oneCase, getInfo })
    report.driver = { revision: binding.driverRevision, runId: binding.runId, authorization: 'existing_actions_branch_push_guard' }
    report.additionalBoundsPassed = bounds.length===2 && bounds.every(row=>row.status==='passed')
    report.approvedRuntime={configuration:runtime,runId:approved.runId,observations:runtimeObservations,status:'failed'}
    // A new default does not replace either already-observed task VM.
    // Record it separately; the exact approved template on each owned VM is
    // the runtime evidence for this run, alongside the fixed public build.
    try {
      const after=await runtimeReader({token:env.VERCEL_TEAM_TOKEN})
      report.approvedRuntime.observedDefaultAfter=after
      report.approvedRuntime.defaultUnchanged=JSON.stringify(after)===JSON.stringify(runtime)
    } catch { report.approvedRuntime.defaultAfterStatus='unavailable' }
    try {
      need(new Set(runtimeObservations.map(row=>row.sandboxHash)).size===2,'approved_runtime_instances_missing')
      report.approvedRuntime.status='passed'
    } catch(error) {
      report.approvedRuntime.code=/^lifecycle_bounds_[a-z_]+$/.test(error?.message??'')?error.message:'lifecycle_bounds_runtime_unconfirmed'
      report.additionalBoundsPassed=false
    }
    // Preserve the original driver's issueAcceptance and untested-stage limits.
    await mkdir('issue-1212-mcp-report',{recursive:true})
    await writeFile('issue-1212-mcp-report/lifecycle-bounds.json',JSON.stringify(report,null,2)+'\n')
  } finally { await pool.end() }
  return report
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const controller = new AbortController(), stop = () => controller.abort()
  process.once('SIGTERM',stop); process.once('SIGINT',stop)
  try{const report=await runLifecycleBounds(process.env,JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH,'utf8')),{signal:controller.signal});console.log(JSON.stringify(report));if(report.status!=='passed'||!report.additionalBoundsPassed)process.exitCode=1}
  catch{console.error('lifecycle_bounds_configuration_failed');process.exitCode=1}
  finally{process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop)}
}
