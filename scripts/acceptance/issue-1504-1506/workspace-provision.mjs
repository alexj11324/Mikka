// Normal smoke-owner setup for these two issues only. Never dispatches a task,
// grants a share, edits membership, or deletes an existing workspace.
import { createHash } from 'node:crypto'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { decode, productionSession } from './production-session.mjs'

export const WORKSPACE_NAME = 'Issues 1504-1506 production acceptance'
const SLUG_PREFIX = 'acceptance-1504-1506-'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const SHA = /^[0-9a-f]{40}$/
const reference = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
const fail = code => { throw new Error(code) }
const ERRORS = new Set(['run_id_required', 'acceptance_version_invalid', 'acceptance_http_failed',
  'acceptance_rpc_failed', 'acceptance_identity_mismatch', 'smoke_credentials_missing', 'acceptance_deadline_exceeded',
  'workspace_inventory_invalid', 'workspace_ambiguous', 'workspace_scope_mismatch', 'workspace_not_owned',
  'workspace_not_fresh', 'workspace_create_invalid', 'workspace_creation_outcome_unknown', 'acceptance_signout_failed'])
const safeError = error => ({ error: ERRORS.has(error?.message) ? error.message : 'workspace_setup_failed',
  ...(Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599 ? { httpStatus: error.details.status } : {}) })

export async function provisionWorkspace({ env = process.env, sessionProvider = productionSession, checkpoint = true } = {}) {
  const report = { schemaVersion: 1, issues: [1504, 1506], phase: 'workspace-provision', status: 'failed',
    applicationSha: null, workspaceId: null, workspaceRef: null, smokeOwnerRef: null,
    creationAttempted: false, created: false, reused: false, creationOutcome: 'not_attempted', requests: [] }
  let requests = []
  const save = () => {
    // The session helper stores paths without queries. Never copy a response or RPC body.
    report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method,
      status: Number.isInteger(status) ? status : null,
      headersMs: Number.isFinite(headersMs) && headersMs >= 0 ? headersMs : null }))
    if (!checkpoint) return
    mkdirSync('issue-1504-1506-report', { recursive: true })
    const path = 'issue-1504-1506-report/workspace-provision.json'
    writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path)
  }
  try {
    if (!/^\d{1,24}$/.test(env.GITHUB_RUN_ID ?? '')) fail('run_id_required')
    const slug = SLUG_PREFIX + env.GITHUB_RUN_ID
    await sessionProvider(async session => {
      requests = session.requests
      if (!SHA.test(session.version?.build ?? '')) fail('acceptance_version_invalid')
      report.applicationSha = session.version.build
      report.smokeOwnerRef = reference(session.identity.userId)
      const json = async (path, options = {}) => {
        const response = await session.request(path, { ...options, signal: AbortSignal.timeout(25_000) })
        const value = await response.json().catch(() => null)
        if (!response.ok || value?.error) {
          const error = new Error('acceptance_http_failed'); error.details = { status: response.status }; throw error
        }
        return value
      }
      const rpc = async (action, args) => {
        const envelope = await json('/api/rpc', { body: { version: 1, action, args }, headers: { 'x-mikka-rpc': '1' } })
        const value = decode(envelope?.result)
        if (envelope?.ok !== true || value?.error || value?.ok === false) fail('acceptance_rpc_failed')
        return value
      }
      const discover = async () => {
        const switcher = await json('/api/workspace/switcher')
        const account = switcher.accounts?.find(item => item.id === session.identity.userId)
        if (!account || !Array.isArray(account.choices)) fail('workspace_inventory_invalid')
        const matching = account.choices.filter(item => item.name === WORKSPACE_NAME)
        if (matching.length > 1) fail('workspace_ambiguous')
        if (matching.some(item => !UUID.test(item.id ?? '') || item.kind !== 'team')) fail('workspace_scope_mismatch')
        return matching[0] ?? null
      }
      const identify = id => {
        if (!UUID.test(id ?? '')) fail('workspace_create_invalid')
        report.workspaceId = id; report.workspaceRef = reference(id); save()
      }
      const verify = async (id, exactSlug = null) => {
        const metadata = await json('/api/workspace?workspace=' + id)
        const general = await rpc('workspace-settings.getWorkspaceGeneral', [id])
        if (metadata.workspace?.id !== id || metadata.workspace.name !== WORKSPACE_NAME || metadata.workspace.kind !== 'team' ||
          metadata.currentUserId !== session.identity.userId || general.id !== id || general.name !== WORKSPACE_NAME || general.personal !== false) fail('workspace_scope_mismatch')
        if (metadata.role !== 'admin' || general.canEdit !== true || general.canTransfer !== true ||
          typeof general.slug !== 'string' || !/^acceptance-1504-1506-\d{1,24}$/.test(general.slug) || exactSlug && general.slug !== exactSlug) fail('workspace_not_owned')
        // Setup grants are applied later by the parent under a separate narrow
        // transaction. A reused fixture with extra members is never silently reset.
        if (!Array.isArray(metadata.members) || metadata.members.length !== 1 || metadata.members[0].userId !== session.identity.userId ||
          metadata.members[0].role !== 'admin' || metadata.members[0].status !== 'active' ||
          !Array.isArray(metadata.invitations) || metadata.invitations.length !== 0) fail('workspace_not_fresh')
      }
      const existing = await discover()
      if (existing) {
        identify(existing.id); report.reused = true; report.creationOutcome = 'existing'; save()
        await verify(existing.id)
      } else {
        report.creationAttempted = true; report.created = null; report.creationOutcome = 'unknown'; save()
        let created
        try { created = await rpc('workspace.createWorkspace', [{ name: WORKSPACE_NAME, slug }]) }
        catch (error) {
          // One read-only recovery after a lost acknowledgement. Never resend create.
          report.createError = safeError(error)
          const recovered = await discover().catch(() => null)
          if (!recovered) fail('workspace_creation_outcome_unknown')
          identify(recovered.id)
          await verify(recovered.id, slug)
          report.creationOutcome = 'recovered_after_unknown'; report.status = 'ready'; save(); return
        }
        if (created?.ok !== true || !UUID.test(created.data?.workspaceId ?? '') || created.data.slug !== slug) fail('workspace_create_invalid')
        identify(created.data.workspaceId); report.created = true; report.creationOutcome = 'acknowledged'; save()
        await verify(created.data.workspaceId, slug)
      }
      report.status = 'ready'; save()
    }, { expectedSha: null, deadlineAt: Date.now() + 150_000 })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; Object.assign(report, safeError(error)) }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === 'provision') {
    const report = await provisionWorkspace(); console.log(JSON.stringify(report))
    if (report.status !== 'ready') process.exitCode = 1
  } else console.log('Usage: node workspace-provision.mjs provision (normal smoke credentials and GITHUB_RUN_ID required)')
}
