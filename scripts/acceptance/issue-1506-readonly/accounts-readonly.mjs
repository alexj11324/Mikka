// One observation per account. No message, dispatch, stop, selection, or policy writes.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decode, productionSession } from '../issue-1504-1506/production-session.mjs'
import { ALEX_OWNER_ID, alexSession } from './alex-session.mjs'

export const TARGET = Object.freeze({ id: 'd32ed7ad-4253-47dd-a94a-66b24dd07d35', ref: 'e917cd887945',
  name: 'Issues 1504-1506 production acceptance', slug: 'acceptance-1504-1506-42274865746',
  smokeOwner: 'cL1NXe1mr7WuIS8xWhU37v0p7kNoUMY3', smokeBotRef: '87b186df9c42',
  workflowRunId: 'wrun_41M6S4DDPT0GXRWK0JQRX06QSW' })
const SHA = /^[0-9a-f]{40}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const hash = value => createHash('sha256').update(value).digest('hex')
const ref = value => hash(value).slice(0, 12)
const SOURCES = new Set(['d1751637b97e74c21b09cef6f72c390dc87a142c910940464430c3c71e5363ca',
  '04903b6d2ad4d60a579485ef3e0a705a5a7283cf41414f6a044dbd2074f7e37c'])
const MODELS = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1',
  'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'deepseek-flash', ''])
const fixed = (value, values) => values.includes(value) ? value : 'unknown'
const model = value => MODELS.has(value) ? value : 'unknown'
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
const fail = code => { throw new Error(code) }
const ERRORS = new Set(['alex_credentials_missing', 'smoke_credentials_missing', 'acceptance_identity_mismatch',
  'acceptance_version_invalid', 'acceptance_version_changed', 'acceptance_http_failed', 'acceptance_rpc_failed',
  'acceptance_deadline_exceeded', 'acceptance_signout_failed', 'workspace_target_missing', 'workspace_scope_mismatch',
  'workspace_switch_failed', 'workspace_members_mismatch', 'bots_scope_mismatch', 'baseline_bot_missing',
  'chat_invalid', 'read_action_not_allowed', 'order_invalid', 'menu_invalid', 'policy_invalid'])
const safeError = error => ({ error: ERRORS.has(error?.message) ? error.message : 'readonly_request_failed',
  ...(Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599 ? { httpStatus: error.details.status } : {}) })
const READ_ACTIONS = new Set(['workspace-settings.getWorkspaceGeneral', 'model-order.getModelOrder',
  'execution-settings.getBotModelMenu', 'personal-policy.getCreditShare', 'personal-policy.getSubscriptionShare',
  'personal-policy.getSharePolicy', 'coordinator.syncCoordinatorChat'])

function reader(session) {
  const json = async path => {
    const response = await session.request(path, { signal: AbortSignal.timeout(20_000) })
    const value = await response.json().catch(() => null)
    if (!response.ok || value?.error) { const error = new Error('acceptance_http_failed'); error.details = { status: response.status }; throw error }
    return value
  }
  const rpc = async (action, args = []) => {
    const isSwitch = action === 'workspace.switchWorkspace' && args.length === 1 && args[0] === TARGET.id
    if (!isSwitch && !READ_ACTIONS.has(action)) fail('read_action_not_allowed')
    if ((action === 'coordinator.syncCoordinatorChat' || action === 'execution-settings.getBotModelMenu') &&
      (args.length !== 1 || !UUID.test(args[0] ?? ''))) fail('read_action_not_allowed')
    const response = await session.request('/api/rpc', { signal: AbortSignal.timeout(20_000),
      body: { version: 1, action, args }, headers: { 'x-mikka-rpc': '1' } })
    const envelope = await response.json().catch(() => null)
    const result = decode(envelope?.result)
    if (!response.ok || envelope?.ok !== true || result?.error || result?.ok === false) {
      const error = new Error('acceptance_rpc_failed'); error.details = { status: response.status }; throw error
    }
    return result
  }
  return { json, rpc }
}

async function selectedWorkspace(session, report) {
  const { json, rpc } = reader(session)
  const switcher = await json('/api/workspace/switcher')
  const accounts = Array.isArray(switcher?.accounts) ? switcher.accounts.filter(account => account.id === session.identity.userId) : []
  const choices = accounts.length === 1 && Array.isArray(accounts[0].choices) ? accounts[0].choices : []
  const targets = choices.filter(choice => choice.id === TARGET.id && choice.kind === 'team' && choice.name === TARGET.name)
  if (targets.length !== 1 || ref(targets[0].id) !== TARGET.ref) fail('workspace_target_missing')
  const switched = await rpc('workspace.switchWorkspace', [TARGET.id])
  if (switched?.ok !== true || switched?.data?.workspaceId !== TARGET.id) fail('workspace_switch_failed')
  report.sessionWorkspaceSwitches = 1
  const [metadata, general, actual] = await Promise.all([
    json('/api/workspace?workspace=' + TARGET.id), rpc('workspace-settings.getWorkspaceGeneral', [TARGET.id]),
    json('/api/workspace/switcher'),
  ])
  if (actual?.workspace?.id !== TARGET.id || metadata?.workspace?.id !== TARGET.id || metadata.workspace.kind !== 'team' ||
    metadata.workspace.name !== TARGET.name || metadata.currentUserId !== session.identity.userId ||
    general?.id !== TARGET.id || general.name !== TARGET.name || general.slug !== TARGET.slug || general.personal !== false) fail('workspace_scope_mismatch')
  if (!Array.isArray(metadata.members) || !Array.isArray(metadata.invitations)) fail('workspace_members_mismatch')
  report.workspace = { id: TARGET.id, ref: TARGET.ref, kind: 'team', exactNameAndSlug: true,
    role: fixed(metadata.role, ['admin', 'member']), canEdit: general.canEdit === true, canTransfer: general.canTransfer === true,
    members: metadata.members.map(member => ({ userRef: typeof member.userId === 'string' ? ref(member.userId) : null,
      role: fixed(member.role, ['admin', 'member']), status: fixed(member.status, ['active', 'suspended']) })),
    invitationCount: metadata.invitations.length }
  const expected = new Map([[TARGET.smokeOwner, 'admin'], [ALEX_OWNER_ID, 'member']])
  if (metadata.members.length !== 2 || new Set(metadata.members.map(member => member.userId)).size !== 2 ||
    metadata.members.some(member => expected.get(member.userId) !== member.role || member.status !== 'active') ||
    metadata.invitations.length !== 0 || metadata.role !== expected.get(session.identity.userId)) fail('workspace_members_mismatch')
  return { json, rpc }
}

function scopedBots(value, ownerId) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(bot => !UUID.test(bot?.id ?? '') ||
    bot.ownerId !== ownerId || bot.workspaceId !== TARGET.id)) fail('bots_scope_mismatch')
  return value
}

export function publicOrder(order) {
  if (!Array.isArray(order?.entries) || !Array.isArray(order?.candidates) || order.entries.length > 300 || order.candidates.length > 300) fail('order_invalid')
  const entry = value => {
    const sourceHash = value.source?.kind === 'subscription' && UUID.test(value.source?.connectionId ?? '') ? hash(value.source.connectionId) : null
    return { harness: fixed(value.harness, ['claude_code', 'codex']), model: model(value.model),
      provider: fixed(value.provider, ['claude', 'codex', 'mikka', 'deepseek', 'anthropic', 'openai', 'custom']),
      sourceKind: fixed(value.source?.kind, ['subscription', 'api_key']), sourceRef: sourceHash?.slice(0, 12) ?? null,
      authorizedAlexSource: sourceHash !== null && SOURCES.has(sourceHash),
      block: value.block ? fixed(value.block.reason, ['checking', 'quota', 'expired', 'paused', 'missing', 'removed', 'modelGone', 'keyRefused', 'balance', 'providerUnavailable', 'noDevice']) : null }
  }
  const entries = order.entries.map(entry), candidates = order.candidates.map(entry)
  return { status: 'observed', autoModelRouting: order.autoModelRouting === true, cloudReady: order.cloudReady === true,
    customized: order.customized === true, location: fixed(order.location, ['cloud', 'local']),
    preferredHarness: fixed(order.preferredHarness, ['claude_code', 'codex']), credentialCount: number(order.credentials),
    entries, candidates, candidateCount: candidates.length,
    allCandidatesFromAuthorizedAlexSources: candidates.length > 0 && candidates.every(item => item.authorizedAlexSource),
    sourceOwnership: 'connection_id_matches_preverified_Alex_sources;frozen_run_binding_not_observed' }
}

export function publicMenu(menu) {
  if (!Array.isArray(menu?.groups) || menu.groups.length > 100 || !menu.current || menu.groups.some(group => !Array.isArray(group.options) || group.options.length > 300)) fail('menu_invalid')
  const option = (value, kind) => ({ model: model(value.modelId),
    provider: fixed(value.provider, ['claude', 'codex', 'mikka', 'deepseek', 'anthropic', 'openai', 'custom']),
    optionId: kind === 'subscription' && UUID.test(value.id ?? '') ? value.id : null })
  return { status: 'observed', scope: 'existing_owned_bot',
    current: { ...option(menu.current, menu.current.kind), kind: fixed(menu.current.kind, ['hosted', 'subscription', 'apiKey', 'shared']),
      chosen: menu.current.chosen === true, available: menu.current.available === true,
      availability: fixed(menu.current.availability, ['available', 'checking', 'exhausted']),
      fallback: menu.current.fallback ? fixed(menu.current.fallback, ['preference', 'points', 'quota']) : null },
    groups: menu.groups.map(group => ({ kind: fixed(group.kind, ['hosted', 'subscription', 'apiKey', 'shared']),
      provider: fixed(group.provider, ['claude', 'codex', 'mikka', 'deepseek', 'anthropic', 'openai', 'custom']),
      ...(group.kind === 'hosted' ? { points: number(group.points), trialLeft: number(group.trialLeft) } : {}),
      options: group.options.map(value => option(value, group.kind)) })) }
}

async function accountObservation(label, provider, work) {
  const report = { account: label, status: 'failed', sessionWorkspaceSwitches: 0, chatReads: 0, requests: [] }
  const started = Date.now()
  let requests = []
  try {
    await provider(async session => {
      requests = session.requests
      const expectedOwner = label === 'alex' ? ALEX_OWNER_ID : TARGET.smokeOwner
      if (session.identity?.userId !== expectedOwner) fail('acceptance_identity_mismatch')
      if (!SHA.test(session.version?.build ?? '')) fail('acceptance_version_invalid')
      report.ownerRef = ref(session.identity.userId); report.identityVerified = true
      report.applicationSha = session.version.build
      const helpers = await selectedWorkspace(session, report)
      await work(session, report, helpers)
      if ((await helpers.json('/api/version'))?.build !== report.applicationSha) fail('acceptance_version_changed')
      report.applicationVersionStable = true
      report.status = 'observed'
    }, { expectedSha: null, deadlineAt: started + 150_000 })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { Object.assign(report, safeError(error)); report.status = 'failed' }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
  report.durationMs = Date.now() - started
  return report
}

export async function observeAccounts({ smokeProvider = productionSession, alexProvider = alexSession, checkpoint = true } = {}) {
  const report = { schemaVersion: 1, issues: [1504, 1506], phase: 'account-readonly', startedAt: new Date().toISOString(),
    taskCreationRequests: 0, messageSendRequests: 0, stopRequests: 0, modelSelectionWrites: 0, subscriptionOrCreditWrites: 0,
    status: 'incomplete', accounts: [] }
  report.accounts.push(await accountObservation('smoke', smokeProvider, async (session, observation, { json, rpc }) => {
    const bots = scopedBots(await json('/api/bots'), session.identity.userId)
    const matches = bots.filter(bot => ref(bot.id) === TARGET.smokeBotRef)
    if (matches.length !== 1) fail('baseline_bot_missing')
    observation.botRef = TARGET.smokeBotRef
    observation.chatReads++
    const chat = (await rpc('coordinator.syncCoordinatorChat', [matches[0].id]))?.chat
    if (chat?.botId !== matches[0].id || chat.unchanged || typeof chat.working !== 'boolean' || !Array.isArray(chat.items)) fail('chat_invalid')
    observation.chat = { working: chat.working, activeStream: Boolean(chat.streamRunId),
      targetWorkflowActive: chat.streamRunId === TARGET.workflowRunId, itemCount: chat.items.length,
      idle: !chat.working && !chat.streamRunId }
    observation.observedAt = new Date().toISOString()
  }))
  report.accounts.push(await accountObservation('alex', alexProvider, async (session, observation, { json, rpc }) => {
    const bots = scopedBots(await json('/api/bots'), session.identity.userId)
    observation.ownedBotCount = bots.length
    observation.order = publicOrder(await rpc('model-order.getModelOrder', [TARGET.id]))
    const [credit, subscription, policy] = await Promise.all([
      rpc('personal-policy.getCreditShare', [TARGET.id]), rpc('personal-policy.getSubscriptionShare', [TARGET.id]),
      rpc('personal-policy.getSharePolicy', [TARGET.id]),
    ])
    if (!credit || !subscription || !policy || typeof credit.mine !== 'boolean' || typeof subscription.shared !== 'boolean' || typeof policy.allowed !== 'boolean') fail('policy_invalid')
    observation.credits = { status: 'observed', personallyShared: credit.mine, canShare: credit.canShare === true,
      admin: credit.admin === true, balanceSource: 'existing_bot_menu_hosted_group_when_present', billingRead: false }
    observation.subscriptions = { personal: subscription.personal === true, shared: subscription.shared,
      allowOthers: subscription.allowOthers === true, allowed: subscription.allowed === true,
      ownProviders: Array.isArray(subscription.own) ? subscription.own.map(value => fixed(value, ['claude', 'codex'])) : [],
      pooledProviderCounts: { claude: Array.isArray(subscription.available) ? subscription.available.filter(value => value.provider === 'claude').length : 0,
        codex: Array.isArray(subscription.available) ? subscription.available.filter(value => value.provider === 'codex').length : 0 },
      policy: { allowed: policy.allowed, canEdit: policy.canEdit === true } }
    // Reading a null menu lazily creates a Coordinator. Use only an existing own bot.
    const bot = [...bots].sort((left, right) => left.id.localeCompare(right.id))[0]
    observation.menu = bot ? { ...publicMenu(await rpc('execution-settings.getBotModelMenu', [bot.id])), botRef: ref(bot.id) }
      : { status: 'not_observed_no_existing_bot', scope: 'no_resource_created' }
  }))
  report.status = report.accounts.every(account => account.status === 'observed') ? 'observed' : 'incomplete'
  report.finishedAt = new Date().toISOString()
  if (checkpoint) {
    mkdirSync('issue-1506-readonly-report', { recursive: true })
    writeFileSync('issue-1506-readonly-report/accounts.json', JSON.stringify(report, null, 2) + '\n')
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] !== 'observe') throw new Error('readonly_command_required')
  const report = await observeAccounts()
  console.log(JSON.stringify(report))
  if (report.status !== 'observed') process.exitCode = 1
}
