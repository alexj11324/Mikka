/** #1505 operation helper: read only Vercel logs, keep closed numeric evidence,
 * and align the already-cleaned task samples. Never exports raw log envelopes. */
import { alignServerTimings } from './cloud-startup.mjs'

const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const NATIVE = new Set(['authorize', 'binding', 'selection', 'admit_before', 'access', 'admit_after', 'connection', 'prepare', 'context', 'provider_headers', 'request', 'native_auth'])
const BOOTSTRAP = new Set(['validation', 'source', 'node', 'gh', 'dependencies', 'build', 'cli', 'journal', 'desktop', 'finalize'])
const CLOUD = new Set(['admission', 'execution_identity', 'question_machine', 'question_source', 'provider_state', 'connect', 'record_sandbox',
  'post_connect_admission', 'runtime_configuration', 'read_worker', 'verify_worker', 'install_computer', 'stage_admission', 'stage_release',
  'switch_release', 'read_refreshed_worker', 'verify_refreshed_worker', 'start_desktop', 'credential_bootstrap', 'publish_bootstrap',
  'start_worker', 'worker_register', 'verify_runtime', 'finish', 'rollback'])
const CLAIM = new Set(['authorize', 'identity', 'admission', 'acquire_lease', 'provenance', 'assignment_context', 'credentials_wait', 'response_fence'])
const SPANS = new Set(['cloud.sandbox.credentials', 'cloud.sandbox.create', 'cloud.sandbox.bootstrap', 'cloud.thread.ensure',
  'cloud.worker.claim', 'cloud.worker.claim.native_credentials', 'cloud.worker.claim.github_credentials'])
const DISPATCH = new Set(['runPlacement', 'issueForUser', 'executionWorkspace', 'resolveModelDispatch', 'ensureBotCloudRuntime',
  'bindAgentToConnection', 'authorizeSubscriptionWorkspace', 'ensureDeviceRepository', 'queueCloudRun', 'ensureThreadMachine',
  'startLifecycle', 'resolveRepository', 'authorizeDispatch', 'requestedAgentProfile'])
const ms = value => Number.isFinite(value) && value >= 0 && value <= 86_400_000
const integer = value => Number.isSafeInteger(value) && value >= 0
const bounds = value => integer(value.startedAt) && integer(value.endedAt) && value.endedAt >= value.startedAt
const ok = value => value === 'ok' || value === 'error'
const fail = code => { throw Error(`startup_logs_${code}`) }
const safeError = error => /^startup_logs_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'startup_logs_collection_failed'
const trace = value => ({ ...(/^[a-f0-9]{32}$/.test(value.traceId ?? '') ? { traceId: value.traceId } : {}),
  ...(/^[a-f0-9]{16}$/.test(value.spanId ?? '') ? { spanId: value.spanId } : {}) })

function sanitizeDispatchTiming(value) {
  if (value.boundary !== undefined && value.boundary !== 'dispatch_run_entry') return null
  if (!(value.workflowRunId === null || /^wrun_[A-Za-z0-9]+$/.test(value.workflowRunId ?? ''))
    || !bounds(value) || !ms(value.totalMs) || typeof value.failed !== 'boolean'
    || !(value.attempt === null || integer(value.attempt)) || !(value.stepId === null || /^[A-Za-z0-9_-]{1,150}$/.test(value.stepId ?? ''))
    || !Array.isArray(value.phases) || value.phases.length > 128 || !integer(value.github?.requests) || !ms(value.github?.ms)) return null
  const phases = []
  for (const phase of value.phases) {
    if (!DISPATCH.has(phase?.phase) || !ms(phase.ms)) return null
    phases.push({ phase: phase.phase, ms: phase.ms })
  }
  return { msg: value.msg, workflowRunId: value.workflowRunId, stepId: value.stepId, attempt: value.attempt,
    ...(value.boundary === 'dispatch_run_entry' ? { boundary: value.boundary } : {}),
    startedAt: value.startedAt, endedAt: value.endedAt, totalMs: value.totalMs, failed: value.failed, phases,
    github: { requests: value.github.requests, ms: value.github.ms } }
}

export function sanitizeTimingLog(value, { hashes, workflows, ownedIntervals = [] }) {
  if (!value || typeof value !== 'object') return null
  if (value.msg === 'dispatch_timing') {
    const clean = sanitizeDispatchTiming(value)
    if (!clean) return null
    if (clean.workflowRunId === null) {
      if (clean.failed || clean.boundary !== 'dispatch_run_entry' || !ownedIntervals.some(interval =>
        interval?.msg === 'cloud_startup_timing' && interval.stage === 'cloud.thread.ensure' && hashes.has(interval.runIdHash)
        && bounds(interval) && interval.startedAt >= clean.startedAt && interval.endedAt <= clean.endedAt)) return null
    } else if (!workflows.has(clean.workflowRunId)) return null
    return clean
  }
  if (!hashes.has(value.runIdHash)) return null
  if (value.msg === 'subscription_native_timing') {
    if (!['http', 'context', 'request', 'lease'].includes(value.operation) || !bounds(value) || !ms(value.ms) || !ok(value.outcome)
      || typeof value.truncated !== 'boolean' || !Array.isArray(value.phases) || value.phases.length > 32) return null
    const phases = []
    for (const phase of value.phases) {
      if (!NATIVE.has(phase?.phase) || !ms(phase.startMs) || !ms(phase.ms) || !ok(phase.outcome)) return null
      phases.push({ phase: phase.phase, startMs: phase.startMs, ms: phase.ms, outcome: phase.outcome })
    }
    return { msg: value.msg, runIdHash: value.runIdHash, operation: value.operation, startedAt: value.startedAt,
      endedAt: value.endedAt, ms: value.ms, outcome: value.outcome, truncated: value.truncated, phases, ...trace(value) }
  }
  if (value.msg !== 'cloud_startup_timing') return null
  if (SPANS.has(value.stage) && bounds(value) && ms(value.ms)) return { msg: value.msg, runIdHash: value.runIdHash,
    stage: value.stage, startedAt: value.startedAt, endedAt: value.endedAt, ms: value.ms }
  if (!Array.isArray(value.phases) || value.phases.length > 128) return null
  if (value.stage === 'cloud.thread.phases' || value.stage === 'cloud.worker.claim.phases') {
    const allowed = value.stage === 'cloud.thread.phases' ? CLOUD : CLAIM
    const phases = []
    for (const phase of value.phases) {
      if (!allowed.has(phase?.phase) || !bounds(phase) || !ms(phase.ms)) return null
      phases.push({ phase: phase.phase, startedAt: phase.startedAt, endedAt: phase.endedAt, ms: phase.ms })
    }
    return { msg: value.msg, runIdHash: value.runIdHash, stage: value.stage, phases }
  }
  if (value.stage === 'cloud.bootstrap.phases' && bounds(value)) {
    const phases = []
    for (const phase of value.phases) {
      if (!BOOTSTRAP.has(phase?.name) || !ms(phase.ms)) return null
      phases.push({ name: phase.name, ms: phase.ms })
    }
    return { msg: value.msg, runIdHash: value.runIdHash, stage: value.stage, startedAt: value.startedAt, endedAt: value.endedAt, phases }
  }
  return null
}

const median = values => { const sorted = values.filter(Number.isFinite).sort((a,b) => a-b), middle = Math.floor(sorted.length/2)
  return sorted.length ? sorted.length % 2 ? sorted[middle] : (sorted[middle-1] + sorted[middle])/2 : null }
const stats = values => ({ valuesMs: values, medianMs: median(values), maxMs: values.length ? Math.max(...values) : null })
const eligibleSample = sample => sample.status !== 'failed' && sample.timing?.status === 'aligned' && sample.cleanup?.status === 'passed'

export function summarizeTimings(report, logs) {
  for (const sample of report.samples) {
    sample.serverStartupTimings = logs.filter(log => log.msg === 'cloud_startup_timing' && log.runIdHash === sample.runIdHash)
    const calls = logs.filter(log => log.msg === 'subscription_native_timing' && log.runIdHash === sample.runIdHash).sort((a,b) => a.startedAt-b.startedAt)
    sample.nativeProxyTimings = calls
    // Native request phases are sequential siblings. provider_headers includes
    // upstream headers/TTFB; do not call it pure Mikka overhead or add its HTTP parent.
    sample.nativeProviderCalls = calls.filter(call => call.operation === 'request').map((call, index) => ({ call: index + 1,
      startedAt: call.startedAt, endedAt: call.endedAt, outcome: call.outcome, serviceMs: call.ms,
      measuredPreparationLowerBoundMs: call.phases.filter(phase => phase.phase !== 'provider_headers').reduce((sum, phase) => sum + phase.ms, 0),
      providerHeadersIncludingUpstreamMs: call.phases.find(phase => phase.phase === 'provider_headers')?.ms ?? null,
      truncated: call.truncated, ...trace(call) }))
  }
  alignServerTimings(report, logs)
  report.summary = { grouping: 'harness_and_requested_strategy', statistics: 'raw_values_median_max_no_percentile_estimate',
    durationRule: 'parent_child_and_parallel_intervals_overlap_do_not_sum',
    proxyRule: 'preparation_is_measured_lower_bound_headers_include_upstream_ttfb',
    excludedSamples: report.samples.filter(sample => !eligibleSample(sample)).map(sample => ({ sampleId: sample.sampleId, reason: sample.error ?? sample.timing?.reason ?? 'incomplete' })), groups: [] }
  for (const harness of new Set(report.samples.map(sample => sample.harness))) {
    const rows = report.samples.filter(sample => sample.harness === harness && eligibleSample(sample))
    report.summary.groups.push({ harness, strategy: report.requestedStrategy, samples: rows.length,
      dispatchToAgentStart: stats(rows.map(sample => sample.timing?.dispatchToAgentStartMs).filter(Number.isFinite)),
      dispatchToExecutionStart: stats(rows.map(sample => sample.timing?.dispatchToExecutionStartMs).filter(Number.isFinite)),
      dispatchToFirstProviderChunk: stats(rows.map(sample => sample.timing?.dispatchToFirstProviderChunkMs).filter(Number.isFinite)),
      proxyPreparationLowerBound: stats(rows.flatMap(sample => sample.nativeProviderCalls.map(call => call.measuredPreparationLowerBoundMs))) })
  }
  return report
}

const seconds = value => Number.isFinite(value) ? (value / 1000).toFixed(3) : '—'
const union = intervals => {
  const sorted = intervals.filter(([start,end]) => ms(start) && ms(end) && end >= start).sort((a,b) => a[0]-b[0])
  let total = 0, end = 0
  for (const [start, stop] of sorted) { total += Math.max(0, stop - Math.max(start,end)); end = Math.max(end,stop) }
  return total
}

function perSamplePhases(sample) {
  const phases = new Map(), add = (name, value) => phases.set(name, (phases.get(name) ?? 0) + value)
  for (const item of sample.timing?.phases ?? []) add(`dispatch.${item.phase}`, item.ms)
  for (const item of sample.serverStartupTimings ?? []) {
    if (Number.isFinite(item.ms)) add(item.stage, item.ms)
    const prefix = item.stage === 'cloud.bootstrap.phases' ? 'bootstrap' : item.stage === 'cloud.worker.claim.phases' ? 'cloud.worker.claim' : 'cloud.thread'
    for (const phase of item.phases ?? []) add(`${prefix}.${phase.name ?? phase.phase}`, phase.ms)
  }
  const daemon = sample.daemonStartupTiming
  if (daemon) {
    phases.set('daemon.adapter.start', daemon.ms)
    for (const name of new Set(daemon.phases.map(phase => phase.name)))
      phases.set(name, union(daemon.phases.filter(phase => phase.name === name).map(phase => [phase.startMs,phase.endMs])))
  }
  const preparation = sample.daemonPreparationTiming
  if (preparation) {
    // Its intervals have their own origin and overlap checkout and the later
    // stage. Keep a separate series; neither root is added to the other.
    phases.set('daemon.adapter.preparation', preparation.ms)
    for (const name of new Set(preparation.phases.map(phase => phase.name)))
      phases.set(name.replace('daemon.adapter.', 'daemon.preparation.'),
        union(preparation.phases.filter(phase => phase.name === name).map(phase => [phase.startMs,phase.endMs])))
  }
  return phases
}

export function markdown(report) {
  const lines = ['## #1505 生产云启动测量', '', `状态：**${report.status}**。模式：\`${report.mode}\`；策略标签：\`${report.requestedStrategy}\`。`,
    '', `应用 commit：\`${report.build}\`。worker SHA：\`${report.workerRelease?.configuration?.workerSha ?? 'unavailable'}\`；worker source：\`${report.workerRelease?.configuration?.sourceCommit ?? 'unavailable'}\`。`,
    `部署：\`${report.serverLogCollection?.deploymentId ?? 'unavailable'}\`。日志查询：\`${report.serverLogCollection?.status ?? 'unavailable'}\`。`,
    '', '时长单位为秒。起点取对应 workflow 的 dispatch_timing.startedAt；只有 boundary=dispatch_run_entry 才是 dispatchRun 函数入口。缺少该标记的旧版本起点为 legacy_dispatch_body，仅保留耗时下界，不能通过最终 ≤5 秒验收。agent_start 与首实际 provider/tool chunk 使用服务端存储时点；实际官方任务 ACK 使用同进程单调时钟差加到 stage 收据上。旧 worker 缺少 ACK 时明确留空。',
    '', '| Sample | Harness | 起点边界 | Run ID | 起点→agent_start | 起点→真实接收上界 | 起点→首 provider/tool chunk | 清理 | 分组资格 |', '|---|---|---|---|---:|---:|---:|---|---|']
  for (const sample of report.samples) lines.push(`| ${sample.sampleId} | ${sample.harness} | ${sample.timing?.dispatchBoundary ?? 'legacy_dispatch_body'} | \`${sample.runId ?? 'unavailable'}\` | ${seconds(sample.timing?.dispatchToAgentStartMs)} | ${seconds(sample.timing?.dispatchToExecutionStartMs)} | ${seconds(sample.timing?.dispatchToFirstProviderChunkMs)} | ${sample.cleanup?.status ?? 'unavailable'} | ${eligibleSample(sample) ? '有效单样本' : sample.error ?? '不完整，排除'} |`)
  lines.push('', '### 分组统计', '', '| Harness | n | agent_start median / max | 首 provider/tool chunk median / max |', '|---|---:|---:|---:|')
  for (const group of report.summary?.groups ?? []) lines.push(`| ${group.harness} | ${group.samples} | ${seconds(group.dispatchToAgentStart.medianMs)} / ${seconds(group.dispatchToAgentStart.maxMs)} | ${seconds(group.dispatchToFirstProviderChunk.medianMs)} / ${seconds(group.dispatchToFirstProviderChunk.maxMs)} |`)
  lines.push('', '### 启动分段', '', '父子阶段和并行阶段会重叠，不能跨行求和。claim.native_credentials / github_credentials 与 assignment_context / credentials_wait 也可能重叠。daemon.adapter.preparation 及 daemon.preparation.* 使用独立的预热起点；准备总时间包含等待 checkout，与 repository 和后来的 adapter.start 重叠，不能相加。相同 daemon 阶段在一轮内取各自收据的区间并集；同名串行 server 阶段合计。缺失值不补零；小样本不计算 P95。')
  for (const harness of new Set(report.samples.map(sample => sample.harness))) {
    const samples = report.samples.filter(sample => sample.harness === harness && eligibleSample(sample)), maps = samples.map(perSamplePhases)
    if (!samples.length) continue
    const names = [...new Set(maps.flatMap(map => [...map.keys()]))].sort()
    lines.push('', `#### ${harness}`, '', `| 阶段 | ${samples.map(sample => sample.sampleId).join(' | ')} | median | max |`, `|---|${samples.map(() => '---:|').join('')}---:|---:|`)
    for (const name of names) {
      const values = maps.map(map => map.get(name)), available = values.filter(Number.isFinite)
      lines.push(`| \`${name}\` | ${values.map(seconds).join(' | ')} | ${seconds(median(available))} | ${seconds(Math.max(...available))} |`)
    }
  }
  lines.push('', '### 每次原生 provider 代理调用', '', '准备成本是 Mikka 已测得的开销下限；provider_headers 含上游首响应时间，不能称作纯代理开销，也不能与包含它的 HTTP 父阶段相加。',
    '', '| Sample / call | 准备成本下限 | Provider headers（含上游） | Service total | Outcome | Trace ID |', '|---|---:|---:|---:|---|---|')
  for (const sample of report.samples) for (const call of sample.nativeProviderCalls ?? [])
    lines.push(`| ${sample.sampleId} / ${call.call} | ${seconds(call.measuredPreparationLowerBoundMs)} | ${seconds(call.providerHeadersIncludingUpstreamMs)} | ${seconds(call.serviceMs)} | ${call.outcome} | \`${call.traceId ?? 'unavailable'}\` |`)
  lines.push('', '### 宿主鉴权与代理发送收据', '', '完整性仅指 daemon HttpServerLink/taskFetch 记录的宿主入口。启动准备、共享 heartbeat/run-control/遥测和自然到期后台续租分开记录；官方 CLI 直连 provider 不经过这条 transport。真实任务 ACK 若早于 agent_start，也从 ACK 起检查额外鉴权。',
    '', '| Sample | 官方任务接收信号 | 宿主收据完整 | 宿主额外鉴权/代理 | 判定 |', '|---|---|---|---:|---|')
  for (const sample of report.samples) lines.push(`| ${sample.sampleId} | ${sample.runtimeTiming?.agentAccepted?.kind ?? 'unavailable'} | ${sample.runtimeTiming ? String(sample.runtimeTiming.complete && !sample.runtimeTiming.truncated) : 'unavailable'} | ${sample.runtimeEvidence?.extraRemoteCalls ?? 'unavailable'} | ${sample.runtimeEvidence?.status ?? 'unavailable'} |`)
  lines.push('', '| Sample | Phase | Endpoint 类别 | Shared | Started | Completed | Errors | 请求到响应头总秒数 |', '|---|---|---|---|---:|---:|---:|---:|')
  for (const sample of report.samples) for (const item of sample.runtimeTiming?.counts ?? [])
    lines.push(`| ${sample.sampleId} | ${item.phase} | ${item.endpoint} | ${item.shared} | ${item.started} | ${item.completed} | ${item.errors} | ${seconds(item.ms)} |`)
  lines.push('', '### MCP 子进程业务请求观测', '', 'decision_catalogue 和 decision_record 是目录/决策业务请求，不计为额外权限检查。v3 另列与 claim 元数据 SHA256 一致的本地目录就绪，不能把缺失观测当成零请求。只列实收的物理发送；子进程未收到 close 时终态未知，CLI 自行重启的世代总量也未知。generationCoverage=unverified、allFirstPartyHttpComplete=false；未观测世代的请求总数是 unavailable。宿主声明的远程 MCP 应用必须为 0；CLI 自行从 HOME、项目或插件载入的网络连接不在这份全局计数承诺中。',
    '', '| Sample | 已观测 / 已关闭 child | 目录 / 决策 / pending | claim 本地目录 | 已观测配对完整 | child 终态完整 | 宿主远程 MCP 数 | 证据状态 |', '|---|---:|---:|---:|---|---|---:|---|')
  for (const sample of report.samples) {
    const child = sample.runtimeEvidence?.childBusiness
    lines.push(`| ${sample.sampleId} | ${child?.observedChildren ?? 'unavailable'} / ${child?.closedChildren ?? 'unavailable'} | ${child?.observedCatalogueSends ?? 'unavailable'} / ${child?.observedDecisionSends ?? 'unavailable'} / ${child?.pendingObservedSends ?? 'unavailable'} | ${child?.observedPreparedCatalogues ?? 'unavailable'} | ${child?.observedComplete ?? 'unavailable'} | ${child?.childLifecycleComplete ?? 'unavailable'} | ${child?.remoteMcpServerCount ?? 'unavailable'} | ${child?.status ?? 'unavailable'}${child?.reason ? `: ${child.reason}` : ''} |`)
  }
  lines.push('', '请求相对真实 ACK 的时间仅为同 VM 墙钟差，保留正负值，不用于 5 秒门槛。耗时为子进程从 fetch 发送到响应头返回或异常的单调时钟间隔，不含后续正文读取或 JSON-RPC 解析。',
    '', '| Sample / child.request | 业务操作 | UTC start | UTC end | 耗时秒 | start 相对 ACK 秒 | Outcome |', '|---|---|---|---|---:|---:|---|')
  for (const sample of report.samples) for (const request of sample.runtimeTiming?.mcpHttpTiming?.requests ?? []) {
    const ack = sample.runtimeTiming?.agentAccepted?.at
    lines.push(`| ${sample.sampleId} / ${request.child}.${request.sequence} | ${request.operation} | ${new Date(request.startedAt).toISOString()} | ${request.endedAt === null ? 'unavailable' : new Date(request.endedAt).toISOString()} | ${seconds(request.durationMs)} | ${seconds(Number.isFinite(ack) ? request.startedAt - ack : null)} | ${request.outcome} |`)
  }
  lines.push('', 'v2 收据另外记录正文读取完成或读取异常；下面的耗时从同一次 fetch 开始累计，不是第二次 HTTP 请求。正文读完不代表 JSON-RPC 解析或官方 CLI 已接收任务；v1 历史收据或缺失的正文事件均显示 unavailable，不能补成零。',
    '', '| Sample / child.request | UTC body end | 发送到正文结束秒 | Body outcome |', '|---|---|---:|---|')
  for (const sample of report.samples) for (const request of sample.runtimeTiming?.mcpHttpTiming?.requests ?? [])
    lines.push(`| ${sample.sampleId} / ${request.child}.${request.sequence} | ${request.body ? new Date(request.body.endedAt).toISOString() : 'unavailable'} | ${seconds(request.body?.durationMs)} | ${request.body?.outcome ?? 'unavailable'} |`)
  lines.push('', '### 官方 CLI provider / tool 耗时观察', '', '仅保留官方 OTLP 数字事件，delivery=best_effort，flush=not_confirmed；CLI 正常退出也不能证明每个事件都已送达。以下是已观察到的逐次事件，不是完整 provider 调用总数。',
    '', '| Sample / event | 事件 | 耗时秒 | Outcome | 官方 sequence |', '|---|---|---:|---|---:|')
  for (const sample of report.samples) for (const [index, event] of (sample.runtimeTiming?.officialCliTiming?.events ?? []).entries())
    lines.push(`| ${sample.sampleId} / ${index + 1} | ${event.name} | ${seconds(event.durationMs)} | ${event.outcome} | ${event.sequence ?? 'unavailable'} |`)
  lines.push('', '日志中没有 native call 不能单独证明零调用。当前受测路径的零额外鉴权判定依据是宿主鉴权/代理入口物理计数为零，加固定 worker 版本中 MCP 子进程唯一 fetch 的两类闭式业务路径审计，并有实际目录发送观测。它不宣称所有业务 HTTP 或所有子进程世代已被计数。官方 CLI 遥测为 best effort，未收到事件不会被当作零 provider 请求。', '')
  return lines.join('\n')
}

/** Called after the test already cleaned its own fixtures. One bounded log
 * query with pagination, no periodic polling or production state mutation. */
export async function collectProductionTimings(report, { token, deploymentId, fetchImpl = fetch, now = Date.now, read: providedRead } = {}) {
  const collection = report.serverLogCollection = { status: 'running', source: 'vercel_observability', records: 0, rawEvents: 0, invalid: 0, truncated: 0 }
  const logs = [], pendingDispatch = [], seen = new Set()
  const hashes = new Set(report.samples.map(sample => sample.runIdHash).filter(value => /^[a-f0-9]{16}$/.test(value ?? '')))
  const workflows = new Set(report.samples.map(sample => sample.workflowRunId).filter(value => /^wrun_[A-Za-z0-9]+$/.test(value ?? '')))
  const nativeHashes = new Set(report.samples.filter(sample => sample.eveSessionId).map(sample => sample.runIdHash).filter(value => hashes.has(value)))
  try {
    if (!token || (!hashes.size && !workflows.size)) fail('scope_missing')
    let read = providedRead
    if (!read) {
      const { api } = await import('../ops/deployment-regression.mjs')
      read = (path, body) => api(path, { token, body, fetchImpl, headers: { 'x-vercel-observability-query-reason': 'cli/logs-runtime' } })
    }
    if (!deploymentId) {
      const alias = await read('/v4/aliases/app.aspectlylabs.com')
      if (alias.alias !== 'app.aspectlylabs.com' || alias.projectId !== PROJECT) fail('alias_invalid')
      deploymentId = alias.deploymentId
    }
    if (!/^dpl_[A-Za-z0-9]+$/.test(deploymentId)) fail('deployment_invalid')
    const deployment = await read(`/v13/deployments/${deploymentId}`)
    if ((deployment.gitSource?.sha ?? deployment.meta?.githubCommitSha) !== report.build || deployment.readyState !== 'READY'
      || deployment.target !== 'production') fail('deployment_mismatch')
    collection.deploymentId = deploymentId
    const start = Date.parse(report.startedAt) - 5000, end = now()
    if (!Number.isFinite(start) || start >= end || end - start > 3_600_000) fail('window_invalid')
    collection.windowStart = new Date(start).toISOString(); collection.windowEnd = new Date(end).toISOString()
    const matching = [...hashes, ...workflows].map(value => value).join(' OR ')
    let cursor
    const cursors = new Set()
    for (let page = 0; page < 10; page++) {
      const response = await read('/v1/observability/events', { event: 'vercel.log', scope: { ownerId: TEAM, projectIds: [PROJECT] },
        timeRange: { start: collection.windowStart, end: collection.windowEnd }, select: ['deploymentId', 'environment', 'message', 'truncated'],
        order: 'desc', limit: 1000, filter: `deploymentId:"${deploymentId}" AND environment:production AND (dispatch_timing OR ((${matching}) AND (cloud_startup_timing OR subscription_native_timing)))`,
        ...(cursor ? { cursor } : {}) })
      if (!Array.isArray(response.events) || typeof response.pagination?.hasMore !== 'boolean') fail('response_invalid')
      if (response.meta?.excludedIntervals?.length) fail('intervals_excluded')
      for (const event of response.events) {
        if (event.deploymentId !== deploymentId || event.environment !== 'production') fail('scope_mismatch')
        collection.rawEvents++
        if (event.truncated) { collection.truncated++; continue }
        for (const line of (typeof event.message === 'string' ? event.message : '').split('\n')) {
          let raw
          try { raw = JSON.parse(line) } catch { collection.invalid++; continue }
          // Product-host dispatch has no Workflow identity. Keep only closed
          // numeric candidates until all pages provide the owned server spans.
          const pending = raw?.msg === 'dispatch_timing' && raw.workflowRunId === null
          const clean = pending ? sanitizeDispatchTiming(raw) : sanitizeTimingLog(raw, { hashes, workflows })
          if (!clean) { collection.invalid++; continue }
          const key = JSON.stringify(clean)
          if (!seen.has(key)) { seen.add(key); (pending ? pendingDispatch : logs).push(clean) }
        }
      }
      if (!response.pagination.hasMore) { collection.status = collection.truncated || collection.invalid ? 'partial' : 'query_complete'; break }
      const next = response.pagination.nextCursor
      if (page === 9 || !next || cursors.has(next)) fail('pagination_incomplete')
      cursors.add(next); cursor = next
    }
  } catch (error) { collection.status = 'failed'; collection.error = /^vercel_api_(?:http_[1-5][0-9]{2}|network_unavailable|response_invalid)$/.test(error?.message ?? '') ? error.message : safeError(error) }
  const ownedIntervals = logs.filter(log => log.msg === 'cloud_startup_timing' && log.stage === 'cloud.thread.ensure' && nativeHashes.has(log.runIdHash))
  for (const candidate of pendingDispatch) {
    const clean = sanitizeTimingLog(candidate, { hashes: nativeHashes, workflows, ownedIntervals })
    if (clean) logs.push(clean)
    else collection.invalid++
  }
  if (collection.status === 'query_complete' && collection.invalid) collection.status = 'partial'
  collection.records = logs.length
  collection.coverage = 'completed_log_query_is_not_proof_of_zero_native_calls'
  report.serverTimingLogs = logs
  return summarizeTimings(report, logs)
}
