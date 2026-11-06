// Two new Alex-owned test bots. Normal login/API/model selection only; no model messages.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { alexSession, ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { loadWorkspaceReceipt, validateWorkspaceReceipt, selectOwnedWorkspace, workspaceName, workspaceSlug } from './workspace-setup.mjs'
import { readJson, requireExactSha, rpc, validateChat } from '../issue-1504-1506/coordinator-baseline.mjs'

export const FIXTURE_MODELS = Object.freeze([
  Object.freeze({ key: 'haiku', model: 'claude-haiku-5-5', provider: 'claude', sourceRef: 'ccca34377eae' }),
  Object.freeze({ key: 'luna', model: 'gpt-6-luna', provider: 'codex', sourceRef: 'f05380d0f88c' }),
])
export const OUTPUT_DIR = 'issue-1506-alex-report'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUN_KEY = /^[a-z0-9][a-z0-9-]{0,35}$/
const SHA = /^[0-9a-f]{40}$/
const hash = value => createHash('sha256').update(value).digest('hex')
export const fixtureRef = value => hash(value).slice(0, 12)
const fail = code => { throw new Error(code) }
export const FIXTURE_ERRORS = Object.freeze(['fixture_receipt_invalid', 'fixture_key_invalid', 'fixture_already_exists',
  'fixture_ambiguous', 'fixture_missing', 'fixture_scope_mismatch', 'fixture_not_ready', 'fixture_creation_unknown',
  'fixture_model_unavailable', 'fixture_model_mismatch', 'fixture_source_mismatch', 'fixture_run_key_required',
  'fixture_cleanup_pending', 'workspace_receipt_invalid', 'workspace_not_owned', 'workspace_not_fresh', 'workspace_target_missing', 'workspace_scope_mismatch', 'workspace_switch_failed',
  'acceptance_identity_mismatch', 'alex_credentials_missing', 'acceptance_sha_required', 'acceptance_version_invalid',
  'acceptance_version_mismatch', 'acceptance_version_changed', 'acceptance_http_failed', 'acceptance_rpc_failed',
  'acceptance_signout_failed', 'acceptance_deadline_exceeded', 'chat_invalid', 'chat_not_idle'])
export const fixtureError = error => FIXTURE_ERRORS.includes(error?.message) ? error.message : 'fixture_failed'
export const fixtureName = (runKey, key) => `测试 Acceptance 1506 Alex ${runKey} ${key}`
const sourceHashes = new Set(['ccca34377eae9409a9c3e3c6bca856ba0f9ea23d5fe79e148a560f37c928615c',
  'f05380d0f88c99a624bd7a78b0357c6d4841ddff43438c0bdcf7705d62f5374e'])

export function validateFixtureReceipt(value, { ready = false } = {}) {
  if (value?.schemaVersion !== 1 || value.issue !== 1506 || value.phase !== 'alex-coordinator-fixtures' ||
    value.ownerRef !== fixtureRef(ALEX_OWNER_ID) || !UUID.test(value.workspace?.id ?? '') || value.workspace.ref !== fixtureRef(value.workspace.id) ||
    value.workspace.kind !== 'team' || value.workspace.name !== workspaceName(value.runKey) || value.workspace.slug !== workspaceSlug(value.runKey) ||
    !RUN_KEY.test(value.runKey ?? '') || !SHA.test(value.applicationSha ?? '') || !Array.isArray(value.fixtures) ||
    value.fixtures.length !== FIXTURE_MODELS.length) fail('fixture_receipt_invalid')
  for (const expected of FIXTURE_MODELS) {
    const rows = value.fixtures.filter(row => row.key === expected.key)
    if (rows.length !== 1 || rows[0].model !== expected.model || rows[0].provider !== expected.provider ||
      (rows[0].botId !== null && !UUID.test(rows[0].botId ?? '')) ||
      (rows[0].optionId !== null && !UUID.test(rows[0].optionId ?? '')) ||
      (ready && (rows[0].status !== 'ready' || !UUID.test(rows[0].botId ?? '') || !UUID.test(rows[0].optionId ?? '')))) fail('fixture_receipt_invalid')
  }
  const ids = value.fixtures.map(row => row.botId).filter(Boolean)
  if (new Set(ids).size !== ids.length) fail('fixture_receipt_invalid')
  return value
}

export function loadFixtureReceipt(path, options) {
  if (typeof path !== 'string' || !path) fail('fixture_receipt_invalid')
  let raw, value
  try { raw = readFileSync(path, 'utf8'); if (raw.length > 200_000) fail('fixture_receipt_invalid'); value = JSON.parse(raw) }
  catch { fail('fixture_receipt_invalid') }
  return validateFixtureReceipt(value, options)
}

export async function selectFixtureWorkspace(session, receipt) {
  validateFixtureReceipt(receipt)
  return selectOwnedWorkspace(session, receipt)
}

export function verifyOwnedFixture(bot, receipt, row) {
  if (!bot || !UUID.test(bot.id ?? '') || bot.ownerId !== ALEX_OWNER_ID || bot.workspaceId !== receipt.workspace.id ||
    bot.name !== fixtureName(receipt.runKey, row.key) || (row.botId && row.botId !== bot.id)) fail('fixture_scope_mismatch')
  return bot
}

export function verifyOwnModel(menu, row) {
  const current = menu?.current
  const options = Array.isArray(menu?.groups) ? menu.groups.filter(group => group.kind === 'subscription' && group.provider === row.provider)
    .flatMap(group => Array.isArray(group.options) ? group.options : []) : []
  if (!UUID.test(row.optionId ?? '') || !current || current.id !== row.optionId || current.modelId !== row.model ||
    current.provider !== row.provider || current.kind !== 'subscription' || current.chosen !== true || current.fallback ||
    !options.some(option => option.id === current.id && option.modelId === row.model && option.provider === row.provider) ||
    !(current.available === true || current.available === false && current.availability === 'checking')) fail('fixture_model_mismatch')
  return { model: row.model, provider: row.provider, kind: 'subscription', chosen: true, listedAsOwnOption: true,
    available: current.available, availability: current.available ? 'available' : 'checking', admissionPending: !current.available,
    fallback: false, optionId: row.optionId, runtimeModelConfirmed: false, runtimeOwnerAccessConfirmed: false }
}

export async function openAcceptanceFixture(session, env = process.env, receiptOverride = null) {
  const receipt = receiptOverride ? validateFixtureReceipt(receiptOverride, { ready: true })
    : loadFixtureReceipt(env.MIKKA_FIXTURE_RECEIPT, { ready: true })
  const key = env.MIKKA_FIXTURE_KIND
  if (!FIXTURE_MODELS.some(item => item.key === key)) fail('fixture_key_invalid')
  const workspace = await selectFixtureWorkspace(session, receipt)
  const row = receipt.fixtures.find(item => item.key === key)
  const bots = await readJson(session, '/api/bots')
  const matches = Array.isArray(bots) ? bots.filter(bot => bot.id === row.botId) : []
  if (matches.length !== 1) fail('fixture_missing')
  verifyOwnedFixture(matches[0], receipt, row)
  const menu = verifyOwnModel(await rpc(session, 'execution-settings.getBotModelMenu', [row.botId]), row)
  return { workspace, botId: row.botId, botRef: fixtureRef(row.botId), fixtureKey: key, fixtureRunKey: receipt.runKey, menu }
}

async function patchHidden(session, botId) {
  const response = await session.request('/api/mobile/bots/' + botId, { method: 'PATCH', body: { hidden: true }, signal: AbortSignal.timeout(20_000) })
  const value = await response.json().catch(() => null)
  if (!response.ok || value?.ok !== true) fail('acceptance_http_failed')
}

export async function runFixtureSetup({ env = process.env, mode = 'setup', receiptPath = null, receipt: suppliedReceipt = null,
  workspaceReceipt: suppliedWorkspace = null, checkpoint = true, sessionProvider = alexSession } = {}) {
  const started = Date.now()
  const previous = suppliedReceipt ? validateFixtureReceipt(suppliedReceipt) : receiptPath ? loadFixtureReceipt(receiptPath) : null
  if (!['setup', 'resume', 'cleanup'].includes(mode) || mode !== 'setup' && !previous) fail('fixture_receipt_invalid')
  const expectedSha = mode === 'cleanup' ? null : requireExactSha(env.MIKKA_ACCEPTANCE_SHA)
  const workspaceReceipt = previous ? null : suppliedWorkspace ? validateWorkspaceReceipt(suppliedWorkspace) : loadWorkspaceReceipt(env.MIKKA_WORKSPACE_RECEIPT)
  const runKey = previous?.runKey ?? workspaceReceipt.runKey
  if (!RUN_KEY.test(runKey ?? '')) fail('fixture_run_key_required')
  const report = previous ? structuredClone(previous) : { schemaVersion: 1, issue: 1506, phase: 'alex-coordinator-fixtures',
    runKey, ownerRef: fixtureRef(ALEX_OWNER_ID), workspace: workspaceReceipt.workspace,
    applicationSha: expectedSha, fixtures: FIXTURE_MODELS.map(item => ({ key: item.key, model: item.model, provider: item.provider,
      botId: null, optionId: null, createAttempted: false, selectionAttempted: false, status: 'pending' })) }
  Object.assign(report, { mode, status: 'failed', modelMessages: 0, taskCreationRequests: 0, subscriptionOrCreditWrites: 0,
    startedAt: new Date(started).toISOString(), requests: [] })
  const output = `${OUTPUT_DIR}/coordinator-fixtures${mode === 'cleanup' ? '-cleanup' : ''}.json`
  let requests = []
  const save = () => {
    report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
    if (!checkpoint) return
    mkdirSync(OUTPUT_DIR, { recursive: true }); writeFileSync(output + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(output + '.tmp', output)
  }
  try {
    await sessionProvider(async session => {
      requests = session.requests
      await selectFixtureWorkspace(session, report)
      if (!SHA.test(session.version?.build ?? '') || expectedSha && session.version.build !== expectedSha) fail('acceptance_version_mismatch')
      report.observedApplicationSha = session.version.build
      if (mode !== 'cleanup') {
        const order = await rpc(session, 'model-order.getModelOrder', [report.workspace.id])
        if (!Array.isArray(order?.candidates) || !order.candidates.length || order.candidates.some(item =>
          item.source?.kind !== 'subscription' || !UUID.test(item.source?.connectionId ?? '') || !sourceHashes.has(hash(item.source.connectionId)))) fail('fixture_source_mismatch')
        for (const target of FIXTURE_MODELS) if (!order.candidates.some(item => item.model === target.model && item.provider === target.provider &&
          fixtureRef(item.source.connectionId) === target.sourceRef)) fail('fixture_model_unavailable')
        report.authorizedSourceCandidates = true
      }
      let bots = await readJson(session, '/api/bots')
      if (!Array.isArray(bots)) fail('fixture_scope_mismatch')
      for (const row of report.fixtures) {
        try {
          const matches = bots.filter(bot => bot.name === fixtureName(runKey, row.key))
          if (matches.length > 1) fail('fixture_ambiguous')
          if (mode === 'setup' && matches.length && !row.createAttempted) fail('fixture_already_exists')
          let bot = matches[0]
          if (!bot && (row.botId || row.createAttempted)) fail('fixture_creation_unknown')
          if (!bot && mode === 'cleanup') { row.cleanup = { hidden: false, absent: true, status: 'complete' }; continue }
          if (!bot) {
            if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
            row.createAttempted = true; save()
            try { bot = await readJson(session, '/api/bots', { body: { name: fixtureName(runKey, row.key) } }); row.creationOutcome = 'acknowledged' }
            catch {
              bots = await readJson(session, '/api/bots')
              const recovered = Array.isArray(bots) ? bots.filter(value => value.name === fixtureName(runKey, row.key)) : []
              if (recovered.length !== 1) fail('fixture_creation_unknown')
              bot = recovered[0]; row.creationOutcome = 'recovered_after_unknown'
            }
          }
          verifyOwnedFixture(bot, report, row); row.botId = bot.id; save()
          const chat = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [bot.id]))
          if (chat.botId !== bot.id) fail('fixture_scope_mismatch')
          if (mode === 'cleanup') {
            row.cleanup = { stopRequested: false, hidden: false, status: 'running' }; save()
            let current = chat
            if (chat.working || chat.streamRunId) {
              row.cleanup.stopRequested = true; save()
              const stopped = await rpc(session, 'coordinator.stopCoordinatorTurn', [bot.id])
              row.cleanup.stopAcknowledged = stopped?.stopped === true
              current = validateChat(await rpc(session, 'coordinator.syncCoordinatorChat', [bot.id]))
              if (current.botId !== bot.id) fail('fixture_scope_mismatch')
            }
            row.cleanup.idle = !current.working && !current.streamRunId
            if (!row.cleanup.idle) fail('fixture_cleanup_pending')
            await patchHidden(session, bot.id); row.cleanup.hidden = true; row.cleanup.status = 'complete'
            save(); continue
          }
          if (!chat.enabled || chat.working || chat.streamRunId || (mode === 'setup' && chat.items.length !== 0)) fail('chat_not_idle')
          let menu = await rpc(session, 'execution-settings.getBotModelMenu', [bot.id])
          if (!row.selectionAttempted) {
            const options = Array.isArray(menu?.groups) ? menu.groups.filter(group => group.kind === 'subscription' && group.provider === row.provider)
              .flatMap(group => group.options ?? []).filter(option => UUID.test(option.id ?? '') && option.modelId === row.model && option.provider === row.provider) : []
            if (options.length !== 1) fail(options.length > 1 ? 'fixture_ambiguous' : 'fixture_model_unavailable')
            row.optionId = options[0].id; row.selectionAttempted = true; save()
            try { menu = await rpc(session, 'execution-settings.chooseBotModel', [bot.id, row.optionId]); row.selectionOutcome = 'acknowledged' }
            catch { menu = await rpc(session, 'execution-settings.getBotModelMenu', [bot.id]); row.selectionOutcome = 'read_after_unknown_no_retry' }
          }
          row.menu = verifyOwnModel(menu, row)
          // One normal read verifies the saved choice, independently of the write acknowledgement.
          row.menu = verifyOwnModel(await rpc(session, 'execution-settings.getBotModelMenu', [bot.id]), row)
          row.status = 'ready'; save()
        } catch (error) {
          row.status = 'failed'; row.error = fixtureError(error)
          if (mode === 'cleanup') row.cleanup = { ...row.cleanup, status: 'needs_followup' }
          save()
        }
      }
      if (expectedSha && (await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
      report.status = mode === 'cleanup' ? report.fixtures.every(row => row.cleanup?.status === 'complete') ? 'cleanup_complete' : 'failed'
        : report.fixtures.every(row => row.status === 'ready') ? 'ready' : 'failed'
      report.retainedForAcceptance = mode !== 'cleanup' && report.fixtures.some(row => row.botId)
    }, { expectedSha, deadlineAt: started + 240_000 })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = fixtureError(error) }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.finishedAt = new Date().toISOString(); save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const report = await runFixtureSetup({ mode: process.argv[2] ?? 'setup', receiptPath: process.argv[3] ?? null })
    console.log(JSON.stringify(report))
    if (!['ready', 'cleanup_complete'].includes(report.status)) process.exitCode = 1
  } catch (error) { console.log(JSON.stringify({ issue: 1506, phase: 'alex-coordinator-fixtures', status: 'failed', error: fixtureError(error) })); process.exitCode = 1 }
}
