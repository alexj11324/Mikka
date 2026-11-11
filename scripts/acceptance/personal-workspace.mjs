import { createHash } from 'node:crypto'
import pins from '../../packages/daemon/harness/pins.json' with { type: 'json' }

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
export const PERSONAL_MODELS = Object.freeze({ claude_code: 'claude-haiku-5-5', codex: 'gpt-6-luna' })
export const PERSONAL_FAILURE_CODES = Object.freeze([
  'workspace_required', 'workspace_read_failed', 'workspace_identity_mismatch', 'workspace_not_personal',
  'workspace_owner_unavailable', 'workspace_switch_failed', 'session_changed', 'account_unavailable', 'runtime_unavailable',
  'subscription_metadata_unavailable', 'subscription_missing', 'subscription_not_ready', 'subscription_identity_mismatch', 'model_metadata_unavailable',
  'model_missing_or_ambiguous', 'device_metadata_unavailable', 'device_required', 'device_unavailable',
  'native_runtime_unavailable', 'agent_metadata_unavailable', 'agent_unavailable', 'readiness_blocked', 'options_invalid',
].map(code => `startup_personal_${code}`))
const check = (ok, code) => { if (!ok) throw new Error(`startup_personal_${code}`) }
const hash = value => createHash('sha256').update(value).digest('hex')
const personal = (value, ownerId, workspaceId) => value?.currentUserId === ownerId
  && value.workspace?.id === workspaceId && value.workspace.kind === 'personal' && value.role === 'admin'
const ownMembership = (value, ownerId) => Array.isArray(value.members)
  && value.members.some(member => member.userId === ownerId && member.role === 'admin' && member.status === 'active')
  && value.members.every(member => member.userId === ownerId || member.status !== 'active')

/** Select one explicit, authorized personal Workspace through the normal cookie/RPC path.
 * A query response never substitutes for the subsequent cookie-based readback. */
export async function selectAcceptancePersonal(client, { ownerId, workspace }, rememberOriginal = () => {}) {
  check(typeof ownerId === 'string' && ownerId.length > 0 && UUID.test(workspace ?? ''), 'workspace_required')
  const read = async path => {
    try { return await client.json(path) } catch { throw new Error('startup_personal_workspace_read_failed') }
  }
  const initial = await read('/api/workspace')
  check(initial.currentUserId === ownerId && UUID.test(initial.workspace?.id ?? '') && Array.isArray(initial.choices), 'workspace_identity_mismatch')
  rememberOriginal(initial.workspace.id)
  const choices = initial.choices.filter(choice => choice?.id === workspace)
  check(choices.length === 1 && choices[0].kind === 'personal', 'workspace_not_personal')
  const candidate = await read('/api/workspace?workspace=' + workspace)
  check(personal(candidate, ownerId, workspace), 'workspace_identity_mismatch')
  check(ownMembership(candidate, ownerId), 'workspace_owner_unavailable')
  try {
    const switched = await client.rpc('workspace.switchWorkspace', [workspace])
    check(switched?.workspaceId === workspace, 'workspace_switch_failed')
  } catch { throw new Error('startup_personal_workspace_switch_failed') }
  const selected = await read('/api/workspace')
  check(personal(selected, ownerId, workspace) && ownMembership(selected, ownerId)
    && selected.choices?.filter(choice => choice.id === workspace && choice.kind === 'personal').length === 1, 'workspace_identity_mismatch')
  const session = await read('/api/auth/get-session')
  check(session?.user?.id === ownerId, 'session_changed')
  return { ownerId, adminId: ownerId, workspaceId: workspace, workspaceKind: 'personal', evidence: {
    personalWorkspaceConfirmed: true, personalWorkspaceHash: hash('personal-workspace\0' + workspace),
    personalSelectionBasis: 'explicit-owned-personal-workspace',
  } }
}

/** Readiness checks metadata only. It never creates a Bot/profile/run, installs a CLI,
 * acquires a provider lease, or proves that an actual native model execution succeeded. */
export async function personalReadiness(client, scope, { harness = 'both', deviceId, agentId } = {}) {
  check(scope?.workspaceKind === 'personal' && scope.ownerId === scope.adminId && UUID.test(scope.workspaceId ?? ''), 'workspace_identity_mismatch')
  check(harness === 'both' || Object.hasOwn(PERSONAL_MODELS, harness), 'options_invalid')
  const read = async (operation, code) => {
    try { return { value: await operation() } } catch { return { code: `startup_personal_${code}` } }
  }
  const [subscriptions, devices, agents] = await Promise.all([
    read(() => client.json('/api/subscriptions?workspace=' + scope.workspaceId), 'subscription_metadata_unavailable'),
    read(() => client.rpc('agents.listDevices', []), 'device_metadata_unavailable'),
    read(() => client.rpc('agents.listAgents', []), 'agent_metadata_unavailable'),
  ])
  const order = subscriptions.value?.enabled === true
    ? await read(() => client.rpc('model-order.getModelOrder', [scope.workspaceId]), 'model_metadata_unavailable') : {}
  const checks = (harness === 'both' ? Object.keys(PERSONAL_MODELS) : [harness]).map(kind => {
    const codes = []
    for (const result of [subscriptions, devices, agents, order]) if (result.code) codes.push(result.code)
    const provider = kind === 'codex' ? 'codex' : 'claude'
    if (subscriptions.value) {
      if (subscriptions.value.enabled !== true) codes.push('startup_personal_runtime_unavailable')
      else {
        const connections = Array.isArray(subscriptions.value.connections) ? subscriptions.value.connections.filter(item => item.provider === provider) : []
        const connected = connections.filter(item => item.state === 'connected' && item.paused !== true)
        if (!connections.length) codes.push('startup_personal_subscription_missing')
        else if (!connected.length) codes.push('startup_personal_subscription_not_ready')
        if (order.value) {
          const candidates = (Array.isArray(order.value.candidates) ? order.value.candidates : []).filter(item => item.harness === kind
            && item.model === PERSONAL_MODELS[kind] && item.credentialOwnerId === scope.ownerId
            && item.source?.kind === 'subscription' && connected.some(connection => connection.id === item.source.connectionId))
          if (candidates.length !== 1) codes.push('startup_personal_model_missing_or_ambiguous')
        }
      }
    }
    if (!UUID.test(deviceId ?? '')) codes.push('startup_personal_device_required')
    else if (devices.value) {
      const matches = Array.isArray(devices.value) ? devices.value.filter(item => item.id === deviceId) : []
      const device = matches[0]
      if (matches.length !== 1 || device.enabled !== true || device.online !== true) codes.push('startup_personal_device_unavailable')
      else if (!device.harnesses?.some(item => item.harness === kind && item.installed === true
        && item.subscriptionBroker === true && !item.subscriptionPreflight
        && item.version?.replace(/^codex-cli\s+/, '').replace(/\s+\(Claude Code\)$/, '') === pins.harnesses[kind].version)) codes.push('startup_personal_native_runtime_unavailable')
    }
    if (agents.value && (!UUID.test(agentId ?? '') || !Array.isArray(agents.value)
      || agents.value.filter(item => item.id === agentId && item.deviceId === deviceId && item.harness === kind).length !== 1)) codes.push('startup_personal_agent_unavailable')
    return { harness: kind, model: PERSONAL_MODELS[kind], status: codes.length ? 'blocked' : 'ready_for_attempt', codes: [...new Set(codes)] }
  })
  return { status: checks.every(item => item.status === 'ready_for_attempt') ? 'ready_for_attempt' : 'blocked',
    workspaceKind: 'personal', executionVerified: false, checks }
}
