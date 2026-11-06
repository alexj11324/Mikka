import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { decode, encode } from '../../lib/desktop-rpc/wire.ts'
import { parseOpenUI, isComponent } from '../../lib/openui-lang.ts'

const ORIGIN = 'https://app.aspectlylabs.com'
const BRANCH = 'refs/heads/ops/1515-1517-acceptance'
const ACTIONS = new Set(['workspace.createWorkspace', 'workspace.switchWorkspace', 'workspace-settings.deleteWorkspace',
  'bots.listBots', 'execution-settings.getBotModelMenu', 'execution-settings.chooseBotModel',
  'coordinator.welcomeCoordinator', 'coordinator.sendCoordinatorMessage', 'coordinator.syncCoordinatorChat', 'coordinator.stopCoordinatorTurn'])
const cases = [
  ...['a', 'b', 'c', 'd'].map(option => ({ id: 'claude-' + option, model: 'claude-haiku-5-5', provider: 'claude', option })),
  { id: 'codex-d', model: 'gpt-6-luna', provider: 'codex', option: 'd' },
]
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (value, code) => { if (!value) throw Error(code) }
const publicFailure = error => ({ name: error?.name ?? 'Error', code: /^[a-z_]{1,80}$/.test(error?.message ?? '') ? error.message : 'acceptance_failed' })

/** Only parse the declarative response; model-produced strings are never evaluated. */
export function welcomeOptions(text) {
  const root = parseOpenUI(text), questions = []
  const walk = (value, depth = 0) => {
    if (depth > 25 || !value || typeof value !== 'object') return
    if (Array.isArray(value)) { for (const child of value) walk(child, depth + 1); return }
    if (isComponent(value)) {
      if (value.name === 'BeQuestions') questions.push(...(Array.isArray(value.props.questions) ? value.props.questions : []))
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
  if (method === 'GET') return ['/api/version', '/api/auth/get-session', '/api/bots', '/renderer-manifest.json'].includes(path)
    || /^\/api\/coordinator\/stream\?botId=[a-f0-9-]{36}&wait=1&after=\d{1,7}$/.test(path)
  if (method !== 'POST') return false
  if (['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(path)) return true
  return path === '/api/rpc' && body?.version === 1 && ACTIONS.has(body.action) && Array.isArray(body.args)
}

export async function runAcceptance() {
  check(process.env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && process.env.GITHUB_REF === BRANCH, 'acceptance_scope_mismatch')
  const applicationSha = process.env.APPLICATION_SHA
  check(/^[a-f0-9]{40}$/.test(applicationSha ?? ''), 'application_sha_required')
  const selectedCases = process.env.ACCEPTANCE_CASES === 'claude-d' ? cases.filter(item => item.id === 'claude-d') : cases
  check(['claude-d', 'all'].includes(process.env.ACCEPTANCE_CASES), 'acceptance_cases_invalid')
  const email = process.env.ACME_DEMO_EMAIL, password = process.env.ACME_DEMO_PASSWORD
  check(email && password && process.env.MIKKA_DATABASE_URL, 'acceptance_credentials_required')
  const require = createRequire(resolve(process.env.MIKKA_OPS_DEPENDENCIES, 'package.json'))
  const { Pool } = require('pg')
  const pool = new Pool({ connectionString: process.env.MIKKA_DATABASE_URL, max: 1, connectionTimeoutMillis: 15000, application_name: 'mikka-1516-acceptance-readonly' })
  const report = { issue: 1516, applicationSha, driverRevision: process.env.GITHUB_SHA, startedAt: new Date().toISOString(), cases: [],
    transport: 'published_web_rpc_and_real_ndjson_stream', status: 'running', ordinaryAccountSession: false }
  const jar = new Map()
  let published, ownerId, originalWorkspace
  const request = async (path, body, timeout = 30000, streamKey) => {
    const method = body === undefined ? 'GET' : 'POST'
    check(requestAllowed(path, method, body), 'acceptance_request_denied')
    const response = await fetch(ORIGIN + '/mikka' + path, { method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { origin: ORIGIN, 'cache-control': 'no-store', accept: 'application/json',
        ...(jar.size ? { cookie: [...jar].map(([key, value]) => key + '=' + value).join('; ') } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}), ...(path === '/api/rpc' ? { 'x-mikka-rpc': '1' } : {}),
        ...(streamKey ? { 'x-mikka-stream-key': streamKey } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) })
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(';', 1)[0], at = pair.indexOf('=')
      if (at > 0) jar.set(pair.slice(0, at), pair.slice(at + 1))
    }
    return response
  }
  const json = async (path, body) => {
    const response = await request(path, body), value = await response.json()
    check(response.ok && value && !value.error, 'acceptance_http_failed')
    return value
  }
  const pin = async () => check((await json('/api/version')).build === applicationSha, 'application_build_changed')
  const rpc = async (action, args = []) => {
    check(ACTIONS.has(action) && published?.has(action), 'acceptance_action_not_published')
    const response = await json('/api/rpc', { version: 1, action, args: encode(args) })
    check(response.version === 1 && response.ok === true && Object.hasOwn(response, 'result'), 'acceptance_rpc_failed')
    const value = decode(response.result)
    check(value && !value.error && value.ok !== false, 'acceptance_action_failed')
    return value
  }
  const readSql = async (sql, args) => {
    const db = await pool.connect()
    try {
      await db.query('BEGIN READ ONLY')
      await db.query("SET LOCAL statement_timeout='15s'")
      return (await db.query(sql, args)).rows
    } finally { await db.query('ROLLBACK'); db.release() }
  }
  const streamCursors = new Map()
  const streamTurn = async botId => {
    const cursor = streamCursors.get(botId)
    const start = Date.now(), response = await request('/api/coordinator/stream?botId=' + botId + '&wait=1&after=' + (cursor?.after ?? 0), undefined, 180000, cursor?.key)
    check(response.status === 200 && response.headers.get('content-type')?.includes('application/x-ndjson'), 'turn_stream_unavailable')
    const streamKey = response.headers.get('x-mikka-stream-key')
    check(/^[a-f0-9]{64}$/.test(streamKey ?? ''), 'turn_stream_key_missing')
    const state = { committed: false, badTool: false, error: false, text: '', tools: new Set(), parts: 0, workflowRunId: response.headers.get('x-mikka-stream-run') }
    let buffer = '', bytes = 0
    const accept = line => {
      if (!line.trim()) return
      const part = JSON.parse(line); state.parts++
      check(Number.isInteger(part.sequence) && part.sequence > 0 && part.sequence <= 1000000, 'turn_stream_sequence_invalid')
      streamCursors.set(botId, { key: streamKey, after: part.sequence })
      if (part.type === 'text') state.text += part.delta ?? ''
      if (part.type === 'reset') state.text = part.text ?? ''
      if (part.type === 'committed') state.committed = true
      if (part.type === 'error') state.error = true
      if (part.type === 'tool') { state.tools.add(part.name); if (!part.name || part.name.toLowerCase() === 'none') state.badTool = true }
      if (/NoSuchToolError|AI_NoSuchToolError/.test(line)) state.badTool = true
    }
    const decoder = new TextDecoder()
    for await (const chunk of response.body) {
      bytes += chunk.byteLength; check(bytes < 8000000, 'turn_stream_too_large')
      buffer += decoder.decode(chunk, { stream: true })
      for (;;) { const at = buffer.indexOf('\n'); if (at < 0) break; accept(buffer.slice(0, at)); buffer = buffer.slice(at + 1) }
      // The durable Workflow owns the stream beyond this reply. The app's
      // committed event, not transport EOF, is this turn's completion boundary.
      if (state.committed) break
    }
    if (!state.committed) { buffer += decoder.decode(); accept(buffer) }
    const chat = (await rpc('coordinator.syncCoordinatorChat', [botId])).chat
    check(chat && Array.isArray(chat.items), 'chat_response_invalid')
    const storedBad = chat.items.some(item => item.tools?.some(tool => !tool || tool.toLowerCase() === 'none') || /NoSuchToolError|AI_NoSuchToolError/.test(JSON.stringify(item)))
    const evidence = { elapsedMs: Date.now() - start, committed: state.committed, working: chat.working, chatErrorPresent: Boolean(chat.error),
      streamError: state.error, invalidToolSeen: state.badTool || storedBad, toolNames: [...state.tools], textChars: state.text.length,
      textSha256: hash(state.text), workflowRunId: state.workflowRunId, messages: chat.items.length }
    return { evidence, text: state.text || chat.items.filter(item => item.from === 'coordinator').at(-1)?.text || '' }
  }
  const passTurn = evidence => check(evidence.committed && !evidence.chatErrorPresent && !evidence.streamError && !evidence.invalidToolSeen && evidence.textChars > 0, 'coordinator_turn_failed')
  try {
    await pin()
    await json('/api/auth/sign-in/email', { email, password })
    const session = await json('/api/auth/get-session')
    check(session.user?.email?.toLowerCase() === email.toLowerCase() && session.user?.id, 'acceptance_identity_mismatch')
    ownerId = session.user.id; report.ordinaryAccountSession = true
    const existing = await json('/api/bots')
    check(Array.isArray(existing) && existing.length && existing.every(bot => bot.ownerId === ownerId && bot.workspaceId === existing[0].workspaceId), 'original_workspace_unknown')
    originalWorkspace = existing[0].workspaceId
    const manifest = await json('/renderer-manifest.json')
    check(manifest.version === 1 && manifest.target === 'web' && Array.isArray(manifest.usedActions), 'acceptance_manifest_invalid')
    published = new Set(manifest.usedActions)
    check([...ACTIONS].every(action => published.has(action)), 'acceptance_action_not_published')
    for (const item of selectedCases) {
      const result = { case: item.id, model: item.model, status: 'running' }
      let workspaceId, botId
      const name = 'Issue 1516 acceptance ' + process.env.GITHUB_RUN_ID + ' ' + item.id
      try {
        await pin()
        const created = await rpc('workspace.createWorkspace', [{ name, slug: 'issue-1516-' + process.env.GITHUB_RUN_ID + '-' + item.id }])
        const candidate = created.data?.workspaceId
        check(/^[a-f0-9-]{36}$/.test(candidate ?? '') && candidate !== originalWorkspace, 'temporary_workspace_invalid')
        workspaceId = candidate
        const ownBots = await rpc('bots.listBots')
        check(Array.isArray(ownBots) && ownBots.length === 1 && ownBots[0].coordinator === true, 'fresh_coordinator_missing')
        botId = ownBots[0].id
        const menu = await rpc('execution-settings.getBotModelMenu', [botId])
        const option = menu.groups?.filter(group => group.kind === 'subscription' && group.provider === item.provider)
          .flatMap(group => group.options).find(option => option.modelId === item.model)
        check(option, 'own_subscription_model_missing')
        const picked = await rpc('execution-settings.chooseBotModel', [botId, option.id])
        check(picked.current?.modelId === item.model && picked.current.kind === 'subscription' && picked.current.chosen === true, 'subscription_model_not_selected')
        result.ownSubscriptionSelected = true
        check((await rpc('coordinator.welcomeCoordinator', [botId])).queued === true, 'welcome_not_queued')
        const welcome = await streamTurn(botId); result.welcome = welcome.evidence
        passTurn(welcome.evidence)
        const options = welcomeOptions(welcome.text), label = options.get(item.option).label
        result.option = { value: item.option, labelSha256: hash(label), labelChars: label.length, count: options.size }
        check((await rpc('coordinator.sendCoordinatorMessage', [label, null, botId, randomUUID()])).queued === true, 'selection_not_queued')
        const answer = await streamTurn(botId); result.answer = answer.evidence
        passTurn(answer.evidence)
        result.executions = await readSql(`SELECT status,snapshot->'runtime'->>'harness' AS harness,snapshot->'runtime'->>'model' AS model,
          (snapshot->'runtime'->'modelSelection' IS NOT NULL) AS subscription FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=$2 ORDER BY started_at`, [ownerId, botId])
        check(result.executions.length >= 2 && result.executions.every(row => row.status === 'completed' && row.model === item.model && row.subscription), 'subscription_execution_unverified')
        const [invalid] = await readSql(`SELECT count(*)::int AS count FROM coordinator_messages m CROSS JOIN LATERAL
          jsonb_array_elements(CASE WHEN jsonb_typeof(message->'content')='array' THEN message->'content' ELSE '[]'::jsonb END) p
          WHERE m."userId"=$1 AND m."botId"=$2 AND ((p->>'type' IN ('tool-call','tool-result') AND coalesce(p->>'toolName','') IN ('none','')) OR p::text LIKE '%NoSuchToolError%')`, [ownerId, botId])
        result.invalidToolRecords = invalid.count; check(invalid.count === 0, 'invalid_tool_persisted')
        const settled = (await rpc('coordinator.syncCoordinatorChat', [botId])).chat
        result.finalWorking = settled?.working; result.finalChatErrorPresent = Boolean(settled?.error)
        check(settled && !settled.working && !settled.error, 'coordinator_did_not_settle')
        await pin(); result.status = 'passed'
      } catch (error) { result.status = 'failed'; result.error = publicFailure(error) }
      finally {
        if (botId) {
          result.stopAcknowledged = await rpc('coordinator.stopCoordinatorTurn', [botId]).then(() => true, () => false)
          if (!result.executions) result.executions = await readSql(`SELECT status,snapshot->'runtime'->>'harness' AS harness,snapshot->'runtime'->>'model' AS model,
            (snapshot->'runtime'->'modelSelection' IS NOT NULL) AS subscription FROM agent_kit_executions WHERE owner_id=$1 AND bot_key=$2 ORDER BY started_at`, [ownerId, botId]).catch(() => [])
        }
        if (workspaceId) {
          result.temporaryWorkspaceRemoved = await rpc('workspace-settings.deleteWorkspace', [workspaceId, name]).then(value => Boolean(value.deleted), () => false)
          const [remaining] = await readSql('SELECT count(*)::int AS count FROM bots WHERE "ownerId"=$1 AND "workspaceId"=$2', [ownerId, workspaceId]).catch(() => [{ count: null }])
          result.remainingTestBots = remaining.count
          if (!result.temporaryWorkspaceRemoved || remaining.count !== 0) { result.status = 'failed'; result.cleanupError = 'temporary_workspace_cleanup_failed' }
        }
        if (originalWorkspace) result.originalWorkspaceRestored = await rpc('workspace.switchWorkspace', [originalWorkspace]).then(() => true, () => false)
        report.cases.push(result)
        console.log(JSON.stringify({ case: result.case, status: result.status, code: result.error?.code ?? result.cleanupError ?? null, cleanup: result.temporaryWorkspaceRemoved ?? true }))
      }
    }
    report.status = report.cases.every(item => item.status === 'passed' && item.originalWorkspaceRestored) ? 'passed' : 'failed'
  } catch (error) { report.status = 'failed'; report.error = publicFailure(error) }
  finally {
    if (jar.size) report.sessionClosed = await request('/api/auth/sign-out', {}).then(response => response.ok, () => false)
    jar.clear(); await pool.end()
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
  const text = 'root = Stack([TextContent("Hi"), BeQuestions("Start", [{id:"start", title:"What", options:[{value:"a", label:"A"},{value:"b",label:"B"},{value:"c",label:"C"},{value:"d",label:"D"}], allowCustom:true}])])'
  assert.equal(welcomeOptions(text).get('d').label, 'D')
  assert.throws(() => welcomeOptions('root = globalThis.process.exit(1)'), /welcome_options_missing/)
  console.log('5 acceptance-driver boundary checks passed')
} else await runAcceptance()
