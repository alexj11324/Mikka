/** #1505 operation helper: read only Vercel logs, keep closed numeric evidence,
 * and align the already-cleaned task samples. Never exports raw log envelopes. */
import { alignServerTimings } from './cloud-startup.mjs'

const PROJECT = 'prj_VdNz3P0FmuRbZKeI40hbCqwR0NVH', TEAM = 'team_C7lwxVVvnUicFli6112mvxpv'
const NATIVE = new Set(['authorize', 'binding', 'selection', 'admit_before', 'access', 'admit_after', 'connection', 'prepare', 'context', 'provider_headers', 'request'])
const BOOTSTRAP = new Set(['validation', 'source', 'node', 'gh', 'dependencies', 'build', 'cli', 'journal', 'desktop', 'finalize'])
const CLOUD = new Set(['admission', 'execution_identity', 'question_machine', 'question_source', 'provider_state', 'connect', 'record_sandbox',
  'post_connect_admission', 'runtime_configuration', 'read_worker', 'verify_worker', 'install_computer', 'stage_admission', 'stage_release',
  'switch_release', 'read_refreshed_worker', 'verify_refreshed_worker', 'start_desktop', 'credential_bootstrap', 'publish_bootstrap',
  'start_worker', 'worker_register', 'verify_runtime', 'finish', 'rollback'])
const SPANS = new Set(['cloud.sandbox.credentials', 'cloud.sandbox.create', 'cloud.sandbox.bootstrap', 'cloud.thread.ensure'])
const DISPATCH = new Set(['runPlacement', 'issueForUser', 'executionWorkspace', 'resolveModelDispatch', 'ensureBotCloudRuntime',
  'bindAgentToConnection', 'authorizeSubscriptionWorkspace', 'ensureDeviceRepository', 'queueCloudRun', 'ensureThreadMachine',
  'startLifecycle', 'resolveRepository'])
const ms = value => Number.isFinite(value) && value >= 0 && value <= 86_400_000
const integer = value => Number.isSafeInteger(value) && value >= 0
const bounds = value => integer(value.startedAt) && integer(value.endedAt) && value.endedAt >= value.startedAt
const ok = value => value === 'ok' || value === 'error'
const fail = code => { throw Error(`startup_logs_${code}`) }
const safeError = error => /^startup_logs_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'startup_logs_collection_failed'
const trace = value => ({ ...(/^[a-f0-9]{32}$/.test(value.traceId ?? '') ? { traceId: value.traceId } : {}),
  ...(/^[a-f0-9]{16}$/.test(value.spanId ?? '') ? { spanId: value.spanId } : {}) })

export function sanitizeTimingLog(value, { hashes, workflows }) {
  if (!value || typeof value !== 'object') return null
  if (value.msg === 'dispatch_timing') {
    if (!workflows.has(value.workflowRunId) || !bounds(value) || !ms(value.totalMs) || typeof value.failed !== 'boolean'
      || !(value.attempt === null || integer(value.attempt)) || !(value.stepId === null || /^[A-Za-z0-9_-]{1,150}$/.test(value.stepId ?? ''))
      || !Array.isArray(value.phases) || value.phases.length > 128 || !integer(value.github?.requests) || !ms(value.github?.ms)) return null
    const phases = []
    for (const phase of value.phases) {
      if (!DISPATCH.has(phase?.phase) || !ms(phase.ms)) return null
      phases.push({ phase: phase.phase, ms: phase.ms })
    }
    return { msg: value.msg, workflowRunId: value.workflowRunId, stepId: value.stepId, attempt: value.attempt,
      startedAt: value.startedAt, endedAt: value.endedAt, totalMs: value.totalMs, failed: value.failed, phases,
      github: { requests: value.github.requests, ms: value.github.ms } }
  }
  if (!hashes.has(value.runIdHash)) return null
  if (value.msg === 'subscription_native_timing') {
    if (!['http', 'context', 'request'].includes(value.operation) || !bounds(value) || !ms(value.ms) || !ok(value.outcome)
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
  if (value.stage === 'cloud.thread.phases') {
    const phases = []
    for (const phase of value.phases) {
      if (!CLOUD.has(phase?.phase) || !bounds(phase) || !ms(phase.ms)) return null
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
    proxyRule: 'preparation_is_measured_lower_bound_headers_include_upstream_ttfb', groups: [] }
  for (const harness of [...new Set(report.samples.map(sample => sample.harness))]) {
    const rows = report.samples.filter(sample => sample.harness === harness)
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
    for (const phase of item.phases ?? []) add(`${item.stage === 'cloud.bootstrap.phases' ? 'bootstrap' : 'cloud.thread'}.${phase.name ?? phase.phase}`, phase.ms)
  }
  const daemon = sample.daemonStartupTiming
  if (daemon) {
    phases.set('daemon.adapter.start', daemon.ms)
    for (const name of new Set(daemon.phases.map(phase => phase.name)))
      phases.set(name, union(daemon.phases.filter(phase => phase.name === name).map(phase => [phase.startMs,phase.endMs])))
  }
  return phases
}

export function markdown(report) {
  const lines = ['## #1505 生产云启动测量', '', `状态：**${report.status}**。模式：\`${report.mode}\`；策略标签：\`${report.requestedStrategy}\`。`,
    '', `应用 commit：\`${report.build}\`。worker SHA：\`${report.workerRelease?.configuration?.workerSha ?? 'unavailable'}\`；worker source：\`${report.workerRelease?.configuration?.sourceCommit ?? 'unavailable'}\`。`,
    `部署：\`${report.serverLogCollection?.deploymentId ?? 'unavailable'}\`。日志查询：\`${report.serverLogCollection?.status ?? 'unavailable'}\`。`,
    '', '时长单位为秒。派发起点取对应 workflow 的 dispatch_timing.startedAt；agent_start 与首实际 provider/tool chunk 使用服务端存储时点。旧 worker 缺少官方任务 ACK 时明确留空。',
    '', '| Sample | Harness | Run ID | 派发→agent_start | 派发→真实接收上界 | 派发→首 provider/tool chunk | 清理 |', '|---|---|---|---:|---:|---:|---|']
  for (const sample of report.samples) lines.push(`| ${sample.sampleId} | ${sample.harness} | \`${sample.runId ?? 'unavailable'}\` | ${seconds(sample.timing?.dispatchToAgentStartMs)} | ${seconds(sample.timing?.dispatchToExecutionStartMs)} | ${seconds(sample.timing?.dispatchToFirstProviderChunkMs)} | ${sample.cleanup?.status ?? 'unavailable'} |`)
  lines.push('', '### 分组统计', '', '| Harness | n | agent_start median / max | 首 provider/tool chunk median / max |', '|---|---:|---:|---:|')
  for (const group of report.summary?.groups ?? []) lines.push(`| ${group.harness} | ${group.samples} | ${seconds(group.dispatchToAgentStart.medianMs)} / ${seconds(group.dispatchToAgentStart.maxMs)} | ${seconds(group.dispatchToFirstProviderChunk.medianMs)} / ${seconds(group.dispatchToFirstProviderChunk.maxMs)} |`)
  lines.push('', '### 启动分段', '', '父子阶段和并行阶段会重叠，不能跨行求和。相同 daemon 阶段在一轮内取区间并集；同名串行 server 阶段合计。缺失值不补零；小样本不计算 P95。')
  for (const harness of new Set(report.samples.map(sample => sample.harness))) {
    const samples = report.samples.filter(sample => sample.harness === harness), maps = samples.map(perSamplePhases)
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
  lines.push('', '日志中没有 native call 不能单独证明零调用。优化后的零额外鉴权门槛还必须通过完整运行生命周期的真实 HTTP 发送收据；官方 CLI 遥测明确为 best effort，未收到事件不会被当作零 provider 请求。', '')
  return lines.join('\n')
}

/** Called after the test already cleaned its own fixtures. One bounded log
 * query with pagination, no periodic polling or production state mutation. */
export async function collectProductionTimings(report, { token, deploymentId, fetchImpl = fetch, now = Date.now, read: providedRead } = {}) {
  const collection = report.serverLogCollection = { status: 'running', source: 'vercel_observability', records: 0, rawEvents: 0, invalid: 0, truncated: 0 }
  const logs = [], seen = new Set()
  const hashes = new Set(report.samples.map(sample => sample.runIdHash).filter(value => /^[a-f0-9]{16}$/.test(value ?? '')))
  const workflows = new Set(report.samples.map(sample => sample.workflowRunId).filter(value => /^wrun_[A-Za-z0-9]+$/.test(value ?? '')))
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
        order: 'desc', limit: 1000, filter: `deploymentId:"${deploymentId}" AND environment:production AND (${matching}) AND (dispatch_timing OR cloud_startup_timing OR subscription_native_timing)`,
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
          const clean = sanitizeTimingLog(raw, { hashes, workflows })
          if (!clean) { collection.invalid++; continue }
          const key = JSON.stringify(clean)
          if (!seen.has(key)) { seen.add(key); logs.push(clean) }
        }
      }
      if (!response.pagination.hasMore) { collection.status = collection.truncated || collection.invalid ? 'partial' : 'query_complete'; break }
      const next = response.pagination.nextCursor
      if (page === 9 || !next || cursors.has(next)) fail('pagination_incomplete')
      cursors.add(next); cursor = next
    }
  } catch (error) { collection.status = 'failed'; collection.error = /^vercel_api_(?:http_[1-5][0-9]{2}|network_unavailable|response_invalid)$/.test(error?.message ?? '') ? error.message : safeError(error) }
  collection.records = logs.length
  collection.coverage = 'completed_log_query_is_not_proof_of_zero_native_calls'
  report.serverTimingLogs = logs
  return summarizeTimings(report, logs)
}
