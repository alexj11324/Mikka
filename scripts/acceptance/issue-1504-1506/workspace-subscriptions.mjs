// Ordinary authenticated metadata inventory. No connect/bind/share/model-generation request.
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { productionSession } from './production-session.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const sha = value => /^[0-9a-f]{40}$/.test(value ?? '') ? value : null
const fixed = (value, values) => values.includes(value) ? value : 'unknown'
const provider = value => fixed(value, ['claude', 'codex'])
const reference = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const knownModels = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol', 'gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.5', 'deepseek-flash'])
const knownStates = ['new', 'pending', 'connected', 'disconnected', 'reconnect_required', 'refreshing', 'publication_pending', 'failed']
const knownBlocks = ['checking', 'quota', 'expired', 'paused', 'missing', 'removed', 'modelGone', 'keyRefused', 'balance', 'providerUnavailable', 'noDevice']
const safeError = error => ({ error: 'metadata_read_failed',
  ...(Number.isInteger(error?.details?.status) ? { httpStatus: error.details.status } : {}) })

export async function inventoryWorkspaces() {
  const report = { schemaVersion: 1, issues: [1504, 1506], phase: 'workspace-subscriptions', status: 'failed',
    driverSha: sha(process.env.GITHUB_SHA), startedAt: new Date().toISOString(),
    taskCreation: 0, modelGenerationRequests: 0, explicitSettingsWrites: 0,
    // Normal product reads can warm catalogues and retire expired sign-in attempts.
    normalReadMaintenancePossible: true, workspaces: [] }
  let requests = []
  try {
    await productionSession(async ({ json, rpc, identity, version, requests: sessionRequests }) => {
      requests = sessionRequests
      if (!sha(version.build)) throw new Error('version_invalid')
      report.applicationSha = version.build
      const switcher = await json('/api/workspace/switcher')
      const account = switcher.accounts?.find(row => row.id === identity.userId)
      if (!account || !Array.isArray(account.choices)) throw new Error('workspace_inventory_invalid')
      const choices = [...new Map(account.choices.filter(row => UUID.test(row.id ?? '')).map(row => [row.id, row])).values()]
      if (!choices.length || choices.length !== account.choices.length) throw new Error('workspace_inventory_invalid')
      report.workspaceCount = choices.length
      report.otherDeviceAccountsIgnored = Math.max(0, (switcher.accounts?.length ?? 1) - 1)
      for (const [index, workspace] of choices.entries()) {
        const row = { index, workspaceRef: reference(workspace.id), current: switcher.workspace?.id === workspace.id,
          kind: fixed(workspace.kind, ['personal', 'team']) }
        let ownConnectionIds = null
        const reads = await Promise.allSettled([
          json('/api/subscriptions?workspace=' + workspace.id),
          rpc('model-order.getModelOrder', [workspace.id]),
          rpc('personal-policy.getSubscriptionShare', [workspace.id]),
        ])
        if (reads[0].status === 'fulfilled') {
          const data = reads[0].value
          const connections = Array.isArray(data.connections) ? data.connections : []
          ownConnectionIds = data.enabled === true ? new Set(connections.map(connection => connection.id)) : null
          row.subscriptions = { status: 'read', enabled: data.enabled === true, ownConnectionCount: connections.length,
            providers: (Array.isArray(data.providers) ? data.providers : []).map(item => ({ provider: provider(item.provider), signInAvailable: item.available === true })),
            connections: connections.map(connection => ({ provider: provider(connection.provider), state: fixed(connection.state, knownStates),
              paused: connection.paused === true, hasError: Boolean(connection.lastErrorCode), activeSignIn: Boolean(connection.activeAttempt),
              selectedBotCount: Array.isArray(connection.bots) ? connection.bots.length : 0 })) }
        } else row.subscriptions = safeError(reads[0].reason)
        const entry = item => ({ harness: fixed(item.harness, ['claude_code', 'codex']),
          model: knownModels.has(item.model) ? item.model : 'unknown',
          source: fixed(item.source?.kind, ['subscription', 'api_key']),
          subscriptionOwner: item.source?.kind !== 'subscription' ? 'not_applicable' : ownConnectionIds === null ? 'unknown'
            : ownConnectionIds.has(item.source.connectionId) ? 'self' : 'shared',
          block: item.block ? fixed(item.block.reason, knownBlocks) : null })
        if (reads[1].status === 'fulfilled') {
          const data = reads[1].value
          row.order = { status: 'read', autoModelRouting: data.autoModelRouting === true, cloudReady: data.cloudReady === true,
            preferredHarness: fixed(data.preferredHarness, ['claude_code', 'codex']),
            entries: (Array.isArray(data.entries) ? data.entries : []).map(entry),
            candidates: (Array.isArray(data.candidates) ? data.candidates : []).map(entry) }
        } else row.order = safeError(reads[1].reason)
        if (reads[2].status === 'fulfilled') {
          const data = reads[2].value
          row.share = { status: 'read', personal: data.personal === true, allowed: data.allowed === true,
            ownShareEnabled: data.shared === true, ownAllowOthers: data.allowOthers === true,
            ownProviders: (Array.isArray(data.own) ? data.own : []).map(provider),
            availableSharedProviders: (Array.isArray(data.available) ? data.available : []).map(item => provider(item.provider)) }
        } else row.share = safeError(reads[2].reason)
        report.workspaces.push(row)
      }
      if ((await json('/api/version')).build !== version.build) throw new Error('version_changed')
      report.applicationVersionStable = true
    })
    const signout = requests.findLast(request => request.path === '/mikka/api/auth/sign-out')
    report.signedOut = Boolean(signout && signout.status >= 200 && signout.status < 300)
    report.status = report.signedOut && report.workspaces.every(row => !row.subscriptions.error && !row.order.error && !row.share.error) ? 'passed' : 'partial'
  } catch (error) {
    report.error = ['version_invalid', 'version_changed', 'workspace_inventory_invalid'].includes(error?.message) ? error.message : 'inventory_failed'
    if (Number.isInteger(error?.details?.status)) report.httpStatus = error.details.status
  }
  report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
  report.finishedAt = new Date().toISOString()
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await inventoryWorkspaces()
  mkdirSync('issue-1504-1506-report', { recursive: true })
  writeFileSync('issue-1504-1506-report/workspace-subscriptions.json', JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  if (report.status !== 'passed') process.exitCode = 1
}
