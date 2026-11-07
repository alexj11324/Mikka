#!/usr/bin/env node
/** Workflow-only bridge for #1512. The driver never receives the progress token.
 * Node 24; --runner-browser additionally uses the workflow's locked Chromium. */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { CASES, fixtureTask } from './run-observability.mjs'

const READY = 'mikka_observability_browser_ready'
const COMMENTS = 'https://api.github.com/repos/alexj11324/Mikka/issues/1512/comments'
const TOKEN_ENV = 'MIKKA_ACCEPTANCE_PROGRESS_TOKEN'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const codes = new Set(['configuration_required', 'driver_start_failed', 'driver_stream_failed', 'progress_invalid', 'progress_duplicate', 'progress_failed', 'browser_start_failed', 'browser_cleanup_failed', 'interrupted'])
class WorkflowError extends Error {
  constructor(code, options = {}) { super(codes.has(code) ? code : 'progress_failed', options); this.code = this.message }
}
const check = (condition, code) => { if (!condition) throw new WorkflowError(code) }

function settings(args, env) {
  check(Array.isArray(args) && args.every(value => ['--execute', '--prepare', '--browser-submit', '--runner-browser'].includes(value))
    && new Set(args).size === args.length && (!args.some(value => ['--prepare', '--browser-submit'].includes(value)) || args.includes('--execute')), 'configuration_required')
  const browser = args.includes('--browser-submit'), runner = args.includes('--runner-browser'), token = env[TOKEN_ENV]
  check(!runner || browser && args.includes('--execute'), 'configuration_required')
  const revision = env.MIKKA_EXPECTED_DEPLOYMENT_SHA, item = CASES.find(value => value.id === env.MIKKA_OBSERVABILITY_MODEL_CASE)
  const timeoutMs = Number(env.MIKKA_OBSERVABILITY_TIMEOUT_MS ?? 480_000)
  if (browser) check(typeof token === 'string' && token.length > 0 && token.length <= 4096 && !/[\r\n]/.test(token)
    && /^[0-9a-f]{40}$/.test(revision ?? '') && item && Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000 && timeoutMs <= 600_000, 'configuration_required')
  if (runner) check(env.GITHUB_ACTIONS === 'true' && env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_REF === 'refs/heads/main'
    && env.GITHUB_SHA === revision, 'configuration_required')
  return { browser, runner, token, revision, item, timeoutMs }
}

/** Reconstruct all text from checked-in fixture code, never from account data.
 * Exact object equality also refuses unrecognized fields in the progress line. */
export function browserReadyComment(value, { revision, item, timeoutMs, now = Date.now(), runner = false }) {
  check(CASES.includes(item) && /^[0-9a-f]{40}$/.test(revision ?? '') && value && typeof value === 'object', 'progress_invalid')
  const fixture = fixtureTask(revision, item), expires = Date.parse(value.expiresAt)
  check(typeof value.workspaceId === 'string' && UUID.test(value.workspaceId) && typeof value.botId === 'string' && UUID.test(value.botId)
    && Number.isFinite(expires) && value.expiresAt === new Date(expires).toISOString() && expires > now + 10_000 && expires <= now + timeoutMs, 'progress_invalid')
  const safe = { type: READY, version: 1, revision, case: item.id, workspaceId: value.workspaceId, botId: value.botId,
    profileId: fixture.profileId, marker: fixture.marker, model: item.model, harness: item.harness,
    destination: 'cloud', input: fixture.input, artifact: { title: fixture.title, content: fixture.content }, expiresAt: value.expiresAt }
  check(isDeepStrictEqual(value, safe), 'progress_invalid')
  return [
    '## #1512 真实浏览器验收已就绪',
    '',
    runner
      ? 'Runner 将使用独立浏览器完成普通登录，并自动点击一次 Create task；请勿人工提交。当前仅准备完成，尚未通过验收。'
      : '执行器正在等待一次真实浏览器提交；当前阶段为准备完成，尚未通过验收。',
    '',
    '| 字段 | 值 |', '| --- | --- |',
    ...Object.entries({ revision, case: item.id, workspaceId: safe.workspaceId, botId: safe.botId,
      profileId: fixture.profileId, marker: fixture.marker, model: item.model, harness: item.harness, expiresAt: safe.expiresAt })
      .map(([key, text]) => '| ' + key + ' | `' + text + '` |'),
    '',
    ...(runner ? [
      '自动浏览器只选择上述工作空间、Coordinator、Mikka Cloud 和 marker 临时 Profile。以下是它将输入的固定验收文本，无需人工操作；不重试提交。',
    ] : [
      '在已有登录的浏览器中切换到上述工作空间，从无项目上下文的页面打开 **New task（新建任务）**，选择 **Coordinator（协调机器人）**、**Mikka Cloud（云端）**，以及名称等于 **marker** 的临时 Profile（配置档案）。',
      '原样粘贴以下由验收代码生成的输入，在 **expiresAt** 之前点击 **Create task（创建任务）一次**。过期后不得发送，也不要重复提交。',
    ]),
    '', '```text', fixture.input, '```', '',
    '浏览器使用自身的真实登录、提交、trace 和回放标识。执行器负责观察和清理本次任务；之后再核验 PostHog 与 Session Replay（会话回放）。',
  ].join('\n')
}

async function startBrowser(options) {
  const { startObservabilityBrowser } = await import('./run-observability-browser.mjs')
  return startObservabilityBrowser(options)
}

export async function runObservabilityWorkflow({ args = process.argv.slice(2), env = process.env, spawnImpl = spawn, fetchImpl = fetch,
  startBrowserImpl = startBrowser, now = Date.now, writeOutput = value => process.stdout.write(value), signals = process } = {}) {
  const config = settings(args, env)
  // Remove the named token, standard aliases and any accidental duplicate of its
  // value. Authentication for the ordinary acceptance account remains runner-local.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    ![TOKEN_ENV, 'GITHUB_TOKEN', 'GH_TOKEN'].includes(key) && !(config.token && typeof value === 'string' && value.includes(config.token))))
  const output = value => writeOutput(config.token ? value.replaceAll(config.token, '[redacted]') : value)
  const requestAbort = new AbortController()
  let child, ended = false, stopping = false, seenReady = false, failure, stderrSeen = false
  let browserStarting, browserSession, exit
  const stop = () => {
    requestAbort.abort()
    if (stopping) return
    stopping = true
    if (child && !ended) child.kill('SIGTERM')
  }
  const fail = error => {
    if (!failure) {
      failure = error instanceof WorkflowError ? error : new WorkflowError('progress_failed', { cause: error })
      output('Run observability workflow: ' + failure.code + '\n')
    }
    stop()
  }
  const interrupted = () => { fail(new WorkflowError('interrupted')) }
  signals.on('SIGINT', interrupted); signals.on('SIGTERM', interrupted)
  let lines
  try {
    try {
      child = spawnImpl(process.execPath, [fileURLToPath(new URL('./run-observability.mjs', import.meta.url)), ...args.filter(value => value !== '--runner-browser')], {
        cwd: fileURLToPath(new URL('../../', import.meta.url)), env: childEnv, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (cause) { throw new WorkflowError('driver_start_failed', { cause }) }
    const finished = new Promise(resolve => child.once('close', (code, signal) => { ended = true; requestAbort.abort(); resolve({ code, signal }) }))
    child.on('error', cause => fail(new WorkflowError('driver_start_failed', { cause })))
    // Runtime diagnostics are not a reviewed account-data channel. Drain them;
    // the driver's final safe JSON and closed helper error code explain failure.
    child.stderr.on('data', () => { if (!stderrSeen) { stderrSeen = true; output('Run observability workflow: driver_stderr_received\n') } })
    lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
    try {
      for await (const line of lines) {
        if (line.length > 65_536) { fail(new WorkflowError('driver_stream_failed')); continue }
        if (!line.trimStart().startsWith('{')) { output(line + '\n'); continue }
        if (failure) continue
        try {
          let value
          try { value = JSON.parse(line) } catch (cause) { throw new WorkflowError('progress_invalid', { cause }) }
          check(config.browser && !ended && !stopping && value?.type === READY, 'progress_invalid')
          check(!seenReady, 'progress_duplicate'); seenReady = true
          const body = browserReadyComment(value, { ...config, now: now() })
          let response
          try {
            response = await fetchImpl(COMMENTS, { method: 'POST', redirect: 'error',
              headers: { authorization: 'Bearer ' + config.token, accept: 'application/vnd.github+json',
                'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
              body: JSON.stringify({ body }), signal: AbortSignal.any([requestAbort.signal, AbortSignal.timeout(10_000)]),
            })
          } catch (cause) { throw new WorkflowError('progress_failed', { cause }) }
          // Never read, print or republish GitHub's response body, even on error.
          await response.body?.cancel().catch(() => {})
          check(response.status === 201, 'progress_failed')
          output('Browser acceptance readiness posted to alexj11324/Mikka#1512.\n')
          if (config.runner) {
            // Keep draining the driver: duplicate readiness or its exit must
            // abort an actor that is still preparing the real UI submission.
            browserStarting = Promise.resolve().then(() => {
              check(!requestAbort.signal.aborted && !ended && !stopping, 'browser_start_failed')
              return startBrowserImpl({ ready: value, env: childEnv, signal: requestAbort.signal })
            }).then(session => {
              check(session && typeof session.close === 'function', 'browser_start_failed')
              browserSession = session
            }).catch(cause => fail(new WorkflowError('browser_start_failed', { cause })))
          }
        } catch (error) { fail(error) }
      }
    } catch (cause) { fail(new WorkflowError('driver_stream_failed', { cause })); child.stdout.resume() }
    exit = await finished // SIGTERM requests cleanup; never abandon the child.
    if (config.runner && !seenReady && exit.code === 0) fail(new WorkflowError('progress_invalid'))
  } finally {
    requestAbort.abort()
    try {
      await browserStarting
      if (browserSession) {
        try { await browserSession.close() }
        catch (cause) { fail(new WorkflowError('browser_cleanup_failed', { cause })) }
      }
    } finally {
      lines?.close()
      signals.removeListener('SIGINT', interrupted); signals.removeListener('SIGTERM', interrupted)
    }
  }
  // Cleanup can turn a successful driver into a failed workflow. Compute the
  // result only after the actor has signed out and closed its own resources.
  if (Number.isInteger(exit.code) && exit.code !== 0) return exit.code
  if (exit.signal) return exit.signal === 'SIGINT' ? 130 : exit.signal === 'SIGTERM' ? 143 : 1
  return failure ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runObservabilityWorkflow() }
  catch (error) {
    console.error('Run observability workflow: ' + (error instanceof WorkflowError ? error.code : 'driver_start_failed'))
    process.exitCode = 1
  }
}
