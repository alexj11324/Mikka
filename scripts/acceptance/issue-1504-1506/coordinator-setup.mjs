// Materialize and verify only this acceptance workspace's Coordinator.
// At the inspected production revision, pooled subscriptions appear as current,
// not as selectable options. A new Coordinator has no saved hosted preference,
// so it resolves pooled Claude before hosted points. Never invent an option id.
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decode, productionSession } from './production-session.mjs'

export const WORKSPACE = Object.freeze({ id: 'd32ed7ad-4253-47dd-a94a-66b24dd07d35', ref: 'e917cd887945',
  name: 'Issues 1504-1506 production acceptance', slug: 'acceptance-1504-1506-42274865746' })
const OWNER_HASH = 'b823ba1c5729768b1da5c3615aba91ac39723bd4c54e9f382b3ed1368d58ec6e'
const CLAUDE_SOURCE_HASH = 'd1751637b97e74c21b09cef6f72c390dc87a142c910940464430c3c71e5363ca'
const SOURCES = new Set([CLAUDE_SOURCE_HASH, '04903b6d2ad4d60a579485ef3e0a705a5a7283cf41414f6a044dbd2074f7e37c'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const hash = value => createHash('sha256').update(value).digest('hex')
const ref = value => hash(value).slice(0, 12)
const fail = code => { throw new Error(code) }
const ERRORS = new Set(['acceptance_sha_required', 'acceptance_version_mismatch', 'acceptance_version_changed',
  'acceptance_identity_mismatch', 'smoke_credentials_missing', 'acceptance_deadline_exceeded', 'acceptance_signout_failed',
  'acceptance_http_failed', 'acceptance_rpc_failed', 'workspace_target_missing', 'workspace_scope_mismatch',
  'workspace_not_owned', 'workspace_switch_failed', 'chat_not_idle', 'coordinator_bot_scope_mismatch',
  'candidate_source_not_authorized', 'authorized_haiku_candidate_missing', 'coordinator_shared_haiku_unavailable'])
const safeError = error => ({ error: ERRORS.has(error?.message) ? error.message : 'coordinator_setup_failed',
  ...(Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599 ? { httpStatus: error.details.status } : {}) })
const fixed = (value, options) => options.includes(value) ? value : 'unknown'

export async function setupCoordinator({ env = process.env, checkpoint = true, sessionProvider = productionSession } = {}) {
  const started = Date.now()
  const report = { schemaVersion: 1, issue: 1506, phase: 'coordinator-setup', status: 'failed',
    workspace: { id: WORKSPACE.id, ref: WORKSPACE.ref, kind: 'team' }, applicationSha: null, botId: null, botRef: null,
    modelSelectionWrites: 0, modelMessages: 0, taskCreationRequests: 0,
    sourceEvidence: 'not_observed', requests: [] }
  let requests = []
  const save = () => {
    report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
    if (!checkpoint) return
    mkdirSync('issue-1504-1506-report', { recursive: true })
    const path = 'issue-1504-1506-report/coordinator-setup.json'
    writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path)
  }
  try {
    if (!SHA.test(env.MIKKA_ACCEPTANCE_SHA ?? '')) fail('acceptance_sha_required')
    report.applicationSha = env.MIKKA_ACCEPTANCE_SHA
    await sessionProvider(async session => {
      requests = session.requests
      if (hash(session.identity.userId) !== OWNER_HASH) fail('acceptance_identity_mismatch')
      if (session.version?.build !== report.applicationSha) fail('acceptance_version_mismatch')
      const json = async (path, options = {}) => {
        const response = await session.request(path, { ...options, signal: AbortSignal.timeout(25_000) })
        const body = await response.json().catch(() => null)
        if (!response.ok || body?.error) {
          const error = new Error('acceptance_http_failed'); error.details = { status: response.status }; throw error
        }
        return body
      }
      const rpc = async (action, args = []) => {
        const envelope = await json('/api/rpc', { body: { version: 1, action, args }, headers: { 'x-mikka-rpc': '1' } })
        const result = decode(envelope?.result)
        if (envelope?.ok !== true || result?.error || result?.ok === false) fail('acceptance_rpc_failed')
        return result
      }
      const switcher = await json('/api/workspace/switcher')
      const account = switcher.accounts?.find(row => row.id === session.identity.userId)
      const targets = account?.choices?.filter(row => row.id === WORKSPACE.id && row.kind === 'team' && row.name === WORKSPACE.name) ?? []
      if (targets.length !== 1 || ref(targets[0].id) !== WORKSPACE.ref) fail('workspace_target_missing')
      const switched = await rpc('workspace.switchWorkspace', [WORKSPACE.id])
      if (switched?.ok !== true || switched.data?.workspaceId !== WORKSPACE.id) fail('workspace_switch_failed')
      const metadata = await json('/api/workspace?workspace=' + WORKSPACE.id)
      const general = await rpc('workspace-settings.getWorkspaceGeneral', [WORKSPACE.id])
      if (metadata.workspace?.id !== WORKSPACE.id || metadata.workspace.kind !== 'team' || metadata.workspace.name !== WORKSPACE.name ||
        metadata.currentUserId !== session.identity.userId || general.id !== WORKSPACE.id || general.name !== WORKSPACE.name ||
        general.slug !== WORKSPACE.slug || general.personal !== false) fail('workspace_scope_mismatch')
      if (metadata.role !== 'admin' || general.canEdit !== true || general.canTransfer !== true) fail('workspace_not_owned')
      const actual = await json('/api/workspace/switcher')
      if (actual.workspace?.id !== WORKSPACE.id) fail('workspace_switch_failed')
      // null names this session's workspace Coordinator. Initialization performs
      // only the product's ordinary bot-row setup, not a model request.
      const initial = (await rpc('coordinator.syncCoordinatorChat', [null]))?.chat
      if (!UUID.test(initial?.botId ?? '') || initial.working !== false || initial.streamRunId || !Array.isArray(initial.items)) fail('chat_not_idle')
      report.botId = initial.botId; report.botRef = ref(initial.botId); save()
      const bots = await json('/api/bots')
      const owned = Array.isArray(bots) ? bots.filter(bot => bot.id === initial.botId) : []
      if (owned.length !== 1 || owned[0].workspaceId !== WORKSPACE.id || owned[0].ownerId !== session.identity.userId) fail('coordinator_bot_scope_mismatch')
      const order = await rpc('model-order.getModelOrder', [WORKSPACE.id])
      if (!Array.isArray(order?.candidates) || !order.candidates.length || order.candidates.some(candidate => candidate.source?.kind !== 'subscription' ||
        typeof candidate.source.connectionId !== 'string' || !SOURCES.has(hash(candidate.source.connectionId)))) fail('candidate_source_not_authorized')
      if (!order.candidates.some(candidate => candidate.harness === 'claude_code' && candidate.model === 'claude-haiku-5-5' &&
        hash(candidate.source.connectionId) === CLAUDE_SOURCE_HASH)) fail('authorized_haiku_candidate_missing')
      const menu = await rpc('execution-settings.getBotModelMenu', [initial.botId])
      const current = menu?.current
      report.menu = { model: fixed(current?.modelId, ['claude-haiku-5-5', 'deepseek-flash', 'gpt-6-luna', '']),
        provider: fixed(current?.provider, ['claude', 'codex', 'mikka', 'deepseek']),
        kind: fixed(current?.kind, ['hosted', 'subscription', 'apiKey', 'shared']),
        available: current?.available === true, chosen: current?.chosen === true,
        groups: Array.isArray(menu?.groups) ? menu.groups.map(group => ({ kind: fixed(group.kind, ['hosted', 'subscription', 'apiKey', 'shared']),
          options: Array.isArray(group.options) ? group.options.length : null })) : [] }; save()
      const listed = Array.isArray(menu?.groups) && menu.groups.some(group => Array.isArray(group.options) && group.options.some(option => option.id === current?.id))
      if (!current || current.modelId !== 'claude-haiku-5-5' || current.provider !== 'claude' || current.kind !== 'subscription' ||
        current.available !== true || current.chosen !== false || !UUID.test(current.id ?? '') || listed) fail('coordinator_shared_haiku_unavailable')
      report.sourceEvidence = 'only_authorized_subscription_candidates_and_unlisted_pooled_haiku;exact_binding_runtime_join_pending'
      report.choice = 'automatic_shared_haiku_already_effective'
      if ((await json('/api/version')).build !== report.applicationSha) fail('acceptance_version_changed')
      report.status = 'ready'
    }, { expectedSha: report.applicationSha, deadlineAt: started + 150_000 })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; Object.assign(report, safeError(error)) }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.durationMs = Date.now() - started; save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'setup') {
    const report = await setupCoordinator(); console.log(JSON.stringify(report))
    if (report.status !== 'ready') process.exitCode = 1
  } else console.log('Usage: node coordinator-setup.mjs setup (normal smoke credentials and exact MIKKA_ACCEPTANCE_SHA required)')
}
