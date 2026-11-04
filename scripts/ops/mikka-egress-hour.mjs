#!/usr/bin/env node
// Fixed workload + public build observation + read-only Neon query generation.
// This never submits a prompt, reads browser credentials, or writes production.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const env = process.env, repo = resolve(env.MIKKA_REPO_PATH ?? process.cwd())
const fail = code => { throw new Error(code) }
const check = (value, code) => { if (!value) fail(code) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const paths = {
  api_key_flash: { model: 'deepseek-flash', harness: 'claude_code', credentialType: 'api_key', subscriptionRoute: null },
  claude_subscription: { model: 'claude-haiku-5-5', harness: 'claude_code', credentialType: 'subscription', subscriptionRoute: 'claude_code_cli' },
  codex_subscription: { model: 'gpt-6-luna', harness: 'codex', credentialType: 'subscription', subscriptionRoute: 'codex_cli' },
}
const executionPath = env.EGRESS_PATH
check(Object.hasOwn(paths, executionPath ?? ''), 'egress_explicit_execution_path_required')
const expected = paths[executionPath]
const sourceSha = env.EGRESS_SOURCE_SHA
check(/^[a-f0-9]{40}$/.test(sourceSha ?? ''), 'egress_source_sha_required')
const files = execFileSync('git', ['ls-tree', '-r', '--name-only', sourceSha, '--', 'lib/factory', 'lib/coordinator', 'lib/cloud-computer'],
  { cwd: repo, encoding: 'utf8' }).trim().split('\n').filter(path => /\.(ts|mjs)$/.test(path)).sort()
check(files.length >= 100, 'egress_source_manifest_incomplete')
const manifestSha256 = sha256(files.join('\n'))
// Hash the full core contract, with placeholders for its own digest and the
// chosen UTC window. A wording or delivery change creates a different workload.
const corePrompt = [
  '执行一次有实际产出的回归审计，目标是 alexj11324/Mikka 的 Factory、Coordinator、Cloud-computer。',
  '冻结源提交：' + sourceSha + '；清单 SHA-256：' + manifestSha256 + '；工作定义 SHA-256：{workloadDigest}。',
  '本任务使用 readOnly:true 的独立工作树。先确认仓库为 alexj11324/Mikka 且能读取该提交；审阅及测试都针对该提交，不把当前 main 的文件或测试结果算作固定源。文件清单由 git ls-tree -r --name-only ' + sourceSha +
    ' -- lib/factory lib/coordinator lib/cloud-computer 生成，保留 .ts/.mjs 并按路径升序，共 ' + files.length + ' 个文件。无法读取固定源时立即报告，不用换仓库或后继运行补足窗口。',
  '本次窗口：{windowStart} 至 {windowEnd}。准备完成后依序持续处理尚未审阅的模块，窗口内保持实际源码审阅、测试分析和报告写作。',
  '每项明确记录源文件 SHA-256、关键行为和边界条件、对应既有测试、实际运行命令及退出结果；不要只重复文件名或泛泛总结。先阅读脚本，只有批准的离线测试及本任务本机独立 *_e2e 数据库测试才能运行。没有本机测试条件时如实记录未覆盖，继续源码审阅和可执行的纯单元测试。',
  '保持仓库只读，测试临时文件只放本任务可写的临时目录。不要连接生产数据库，不改生产设置，不创建PR或push，不发第三方消息；不为耗时重复相同工作，不执行 sleep 等空等命令，不切换模型。不得宣称未运行的测试通过。',
  '到窗口结束就停止开始新的审阅项，完成当前记录，在本任务正常回复中输出完整 Markdown 审计报告，再遵循运行器已有的 submit 规则结束任务。交付以本任务实际可见回复和 run_chunks 为证，不要求文件上传，不把聊天正文称为可下载产物。',
  '报告先列 sourceSha、workloadDigest、manifestSha256、startedAt、endedAt，再按清单顺序分节列出每项 path、sourceSha256、startedAt、endedAt、具体审阅结论，以及实际 checks（command、exitCode、result）。最后单列尚未完成的文件。完整记录放在 Markdown 正文中，不用简短交付摘要替代。',
  '如提前完成全部清单、遇到额度暂停或不能继续实际工作，立即明确报告真实时间和原因，不等待到一小时后才假装完成。'
].join('\n')
const workload = { version: 3, name: 'factory-coordinator-cloud-regression-audit', repository: 'alexj11324/Mikka',
  sourceSha, files, concurrentTasks: 1, durationSeconds: 3600, readOnly: true,
  delivery: 'native_markdown_reply', instructions: corePrompt }
const workloadDigest = sha256(JSON.stringify(workload))
const start = Date.parse(env.EGRESS_WINDOW_START ?? '')
check(Number.isFinite(start) && start % 3600000 === 0, 'egress_utc_hour_required')
const end = start + 3600000
const prompt = corePrompt.replaceAll('{workloadDigest}', workloadDigest)
  .replaceAll('{windowStart}', new Date(start).toISOString()).replaceAll('{windowEnd}', new Date(end).toISOString())
// The task definition stays identical across all three paths; the selected path
// is separate provenance and must match for every before/after pair.
const base = { workloadDigest, manifestSha256, sourceSha, executionPath, expected,
  windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString() }
if (process.argv[2] === 'plan') {
  console.log(JSON.stringify({ workload, ...base, prompt,
    dispatchRequirement: { tool: 'dispatch_run', repo: workload.repository, target: 'cloud', readOnly: true,
      model: { harness: expected.harness, model: expected.model } },
    observation: 'One visible task workspace/Factory detail tab. Public version every minute, read-only Neon metadata every five minutes. Review the actual native Markdown report and run events, exact provider hourly bucket, route invocations and idle comparison separately.' }, null, 2))
  process.exit(0)
}
const uuid = value => /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value ?? '')
const runId = env.EGRESS_RUN_ID, issueId = env.EGRESS_ISSUE_ID
if (process.argv[2] === 'neon-sql') {
  check(uuid(runId) && uuid(issueId), 'egress_run_and_issue_required')
  // Preserve raw counts. A row never admitted to an executor is not a live
  // model task just because a historical fixture retained status=running.
  // Exclude it only while all authority and activity fields prove it inert
  // for the entire day before this window; any new activity includes it again.
  const windowStart = "'" + new Date(start).toISOString() + "'::timestamptz"
  const windowEnd = "'" + new Date(end).toISOString() + "'::timestamptz"
  const historicalCutoff = windowStart + " - interval '1 day'"
  const sql = 'WITH other_runs AS MATERIALIZED (SELECT other.id,other."userId",other.status, ' +
    '(other."startedAt"<' + windowEnd + ' AND coalesce(other."finishedAt",now())>' + windowStart + ') AS overlaps, ' +
    'COALESCE((other."agentDefinition" IS NULL AND other."leaseExpiresAt" IS NULL AND other.source IS NULL ' +
    'AND other."startedAt"<' + historicalCutoff + ' AND other."updatedAt"<' + historicalCutoff +
    ' AND NOT EXISTS(SELECT 1 FROM run_chunks activity WHERE activity."runId"=other.id AND activity."createdAt">=' + historicalCutoff + ')),false) AS "historicalUnadmitted" ' +
    'FROM agent_runs other WHERE other.id<>\'' + runId + '\'::uuid AND (other.status=\'running\' OR ' +
    '(other."startedAt"<' + windowEnd + ' AND coalesce(other."finishedAt",now())>' + windowStart + '))) ' +
    'SELECT now() AS "observedAt", r.id AS "runId", r."issueId", r.status, r."startedAt", r."finishedAt", ' +
    'r."agentDefinition"->>\'model\' AS model, r."agentDefinition"->>\'harness\' AS harness, ' +
    'r."agentDefinition"->>\'modelSource\' AS "modelSource", r."agentDefinition"->>\'cliModelSelection\' AS "cliModelSelection", ' +
    'r."agentDefinition"->\'readOnly\' AS "readOnly", ' +
    'r."agentDefinition"->\'apiKey\'->>\'model\' AS "apiKeyModel", ' +
    'r."agentDefinition"->\'subscription\'->>\'modelId\' AS "subscriptionModel", ' +
    'CASE WHEN r."agentDefinition"->\'apiKey\' IS NOT NULL AND r."agentDefinition"->\'apiKey\'<>\'null\'::jsonb ' +
    'AND r."agentDefinition"->\'subscription\' IS NOT NULL AND r."agentDefinition"->\'subscription\'<>\'null\'::jsonb THEN \'conflict\' ' +
    'WHEN r."agentDefinition"->\'apiKey\' IS NOT NULL AND r."agentDefinition"->\'apiKey\'<>\'null\'::jsonb THEN \'api_key\' ' +
    'WHEN r."agentDefinition"->\'subscription\' IS NOT NULL AND r."agentDefinition"->\'subscription\'<>\'null\'::jsonb THEN \'subscription\' ELSE \'unknown\' END AS "credentialType", ' +
    'r."agentDefinition"->\'subscription\'->>\'route\' AS "subscriptionRoute", c.seq AS "lastSeq", c."createdAt" AS "lastEventAt", r."lastReplyAt", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.status=\'running\' AND other."userId"=r."userId" AND NOT other."historicalUnadmitted") AS "otherOwnerRunningRuns", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.status=\'running\' AND NOT other."historicalUnadmitted") AS "otherRunningRuns", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.overlaps AND NOT other."historicalUnadmitted") AS "otherWindowRuns", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.status=\'running\' AND other."userId"=r."userId") AS "rawOtherOwnerRunningRuns", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.status=\'running\') AS "rawOtherRunningRuns", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.overlaps) AS "rawOtherWindowRuns", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.status=\'running\' AND other."userId"=r."userId" AND other."historicalUnadmitted") AS "historicalOwnerRunningRows", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.status=\'running\' AND other."historicalUnadmitted") AS "historicalRunningRows", ' +
    '(SELECT count(*) FROM other_runs other WHERE other.overlaps AND other."historicalUnadmitted") AS "historicalWindowRows" ' +
    'FROM agent_runs r LEFT JOIN LATERAL (SELECT seq,"createdAt" FROM run_chunks WHERE "runId"=r.id ORDER BY seq DESC LIMIT 1) c ON true ' +
    'WHERE r.id=\'' + runId + '\'::uuid AND r."issueId"=\'' + issueId + '\'::uuid;';
  console.log(JSON.stringify({ project_id: 'autumn-fire-21908520', branch_id: 'br-autumn-rain-b5leflom', database_name: 'orvilo_mvp', sql }, null, 2))
  process.exit(0)
}
if (process.argv[2] === 'check-neon') {
  check(uuid(runId) && uuid(issueId) && env.EGRESS_NEON_SAMPLES_PATH, 'egress_neon_samples_required')
  const samples = JSON.parse(await readFile(env.EGRESS_NEON_SAMPLES_PATH, 'utf8'))
  check(Array.isArray(samples), 'egress_neon_samples_not_array')
  const selected = [], review = []
  for (let minute = 0; minute <= 60; minute += 5) {
    const target = start + minute * 60000
    const sample = samples.find(value => Math.abs(Date.parse(value.observedAt) - target) <= 30000)
    check(sample, 'egress_neon_sample_missing_' + minute)
    check(sample.runId === runId && sample.issueId === issueId, 'egress_run_scope_changed')
    check(sample.readOnly === true, 'egress_read_only_required')
    check(sample.model === expected.model && sample.harness === expected.harness
      && sample.cliModelSelection === 'explicit' && sample.modelSource === expected.credentialType
      && sample.credentialType === expected.credentialType && sample.subscriptionRoute === expected.subscriptionRoute,
    'egress_execution_path_changed')
    check(expected.credentialType === 'api_key'
      ? sample.apiKeyModel === expected.model && sample.subscriptionModel === null
      : sample.apiKeyModel === null && sample.subscriptionModel === expected.model, 'egress_credential_model_changed')
    for (const [actual, raw, historical] of [
      ['otherOwnerRunningRuns', 'rawOtherOwnerRunningRuns', 'historicalOwnerRunningRows'],
      ['otherRunningRuns', 'rawOtherRunningRuns', 'historicalRunningRows'],
      ['otherWindowRuns', 'rawOtherWindowRuns', 'historicalWindowRows'],
    ]) {
      check([actual, raw, historical].every(key => /^\d+$/.test(String(sample[key]))), 'egress_activity_scope_evidence_missing')
      check(Number(sample[actual]) + Number(sample[historical]) === Number(sample[raw]), 'egress_activity_scope_mismatch')
    }
    check(Number(sample.otherOwnerRunningRuns) === 0, 'egress_concurrent_owner_run')
    check(Number(sample.otherRunningRuns) === 0, 'egress_concurrent_project_run')
    check(Number(sample.otherWindowRuns) === 0, 'egress_other_run_overlapped_window')
    if (minute === 60) check(Date.parse(sample.observedAt) >= end, 'egress_end_not_observed')
    check(minute < 60 ? sample.status === 'running' : sample.status === 'running' || Date.parse(sample.finishedAt ?? '') >= end,
      'egress_task_stopped_before_hour')
    check(Date.parse(sample.startedAt ?? '') <= start, 'egress_task_started_after_hour')
    if (selected.length && !(Number(sample.lastSeq) > Number(selected.at(-1).lastSeq))) review.push({ minute, reason: 'no_new_events_requires_report_and_test_review' })
    selected.push(sample)
  }
  console.log(JSON.stringify({ ...base, runId, issueId, status: 'samples_observed_pending_provider_and_report_review',
    progressBuckets: selected.length - 1, review, samples: selected }, null, 2))
  process.exit(0)
}
check(process.argv[2] === 'observe', 'egress_mode_plan_neon_sql_check_neon_or_observe_required')
const expectedBuild = env.EGRESS_EXPECTED_BUILD, deploymentId = env.EGRESS_DEPLOYMENT_ID
check(/^[a-f0-9]{40}$/.test(expectedBuild ?? '') && /^dpl_[A-Za-z0-9]+$/.test(deploymentId ?? ''), 'egress_build_configuration_required')
check(Date.now() < start, 'egress_window_already_started')
if (expected.credentialType === 'api_key') execFileSync(process.execPath, ['scripts/assert-test-model.mjs', expected.model], { cwd: repo, stdio: 'ignore' })
const output = resolve(env.EGRESS_REPORT_PATH ?? '/tmp/mikka-egress-hour-versions.json')
const report = { version: 3, ...base, expectedBuild, deploymentId, status: 'observing', checks: [],
  observerScope: 'Public build checks only. Neon progress, provider deployment/alias, hourly billing bucket, route metrics and the native Markdown audit report are reviewed separately.' }
async function save() {
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
try {
  for (let minute = 0; minute <= 60; minute++) {
    const target = start + minute * 60000
    while (Date.now() < target) await delay(Math.min(30000, target - Date.now()))
    check(Date.now() - target < 15000, 'egress_observation_gap')
    const response = await fetch('https://app.aspectlylabs.com/mikka/api/version',
      { signal: AbortSignal.timeout(20000), redirect: 'error', headers: { 'cache-control': 'no-store' } })
    check(response.ok, 'egress_version_http_' + response.status)
    check((await response.json()).build === expectedBuild, 'egress_deployment_changed')
    report.checks.push({ at: new Date().toISOString(), minute, build: expectedBuild })
    await save()
    console.log(JSON.stringify({ minute, build: expectedBuild }))
  }
  report.status = 'build_observed_pending_provider_and_workload_review'
  report.completedAt = new Date().toISOString()
  await save()
  console.log(JSON.stringify({ status: report.status, report: output }))
} catch (error) {
  report.status = 'invalid'
  report.reason = /^egress_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'egress_observation_failed'
  report.completedAt = new Date().toISOString()
  await save()
  console.error(JSON.stringify({ status: report.status, reason: report.reason, report: output }))
  process.exitCode = 1
}

