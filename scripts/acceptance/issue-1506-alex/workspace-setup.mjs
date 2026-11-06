// Create only this run's ACME-owned team, using the ordinary product APIs.
// Sharing uses existing owner resources; no balance is created or changed here.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { ALEX_OWNER_ID, alexSession } from '../issue-1506-readonly/alex-session.mjs'
import { readJson, requireExactSha, rpc } from '../issue-1504-1506/coordinator-baseline.mjs'

export const OUTPUT_DIR = 'issue-1506-alex-report'
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const RUN_KEY = /^[a-z0-9][a-z0-9-]{0,35}$/
const SHA = /^[0-9a-f]{40}$/
export const ref = value => createHash('sha256').update(value).digest('hex').slice(0, 12)
export const workspaceName = runKey => `测试 Issue 1506 ACME ${runKey}`
export const workspaceSlug = runKey => `acceptance-1506-acme-${runKey}`
const fail = code => { throw new Error(code) }
const ERRORS = new Set(['acceptance_identity_mismatch', 'alex_credentials_missing', 'acceptance_sha_required',
  'acceptance_version_mismatch', 'acceptance_version_changed', 'acceptance_http_failed', 'acceptance_rpc_failed',
  'acceptance_deadline_exceeded', 'acceptance_signout_failed', 'workspace_receipt_invalid', 'workspace_run_key_required',
  'workspace_inventory_invalid', 'workspace_ambiguous', 'workspace_scope_mismatch', 'workspace_not_owned',
  'workspace_not_fresh', 'workspace_create_invalid', 'workspace_creation_unknown', 'workspace_share_failed'])
export const setupError = error => ERRORS.has(error?.message) ? error.message : 'workspace_setup_failed'

export function validateWorkspaceReceipt(value) {
  if (value?.schemaVersion !== 1 || value.issue !== 1506 || value.phase !== 'alex-1506-workspace' ||
    value.status !== 'ready' || value.ownerRef !== ref(ALEX_OWNER_ID) || !RUN_KEY.test(value.runKey ?? '') ||
    !SHA.test(value.applicationSha ?? '') || !UUID.test(value.workspace?.id ?? '') ||
    value.workspace.id === '4ae2a643-b09e-43eb-816c-1e5557bef170' || value.workspace.ref !== ref(value.workspace.id) ||
    value.workspace.name !== workspaceName(value.runKey) || value.workspace.slug !== workspaceSlug(value.runKey) ||
    value.workspace.kind !== 'team' || value.shares?.subscription !== true || value.shares?.credit !== true ||
    value.shares?.allowOthers !== false) fail('workspace_receipt_invalid')
  return value
}

export function loadWorkspaceReceipt(path) {
  let value
  try { const raw = readFileSync(path, 'utf8'); if (raw.length > 200_000) fail('workspace_receipt_invalid'); value = JSON.parse(raw) }
  catch { fail('workspace_receipt_invalid') }
  return validateWorkspaceReceipt(value)
}

export async function selectOwnedWorkspace(session, receipt) {
  if (session.identity?.userId !== ALEX_OWNER_ID) fail('acceptance_identity_mismatch')
  const target = receipt.workspace
  if (!UUID.test(target?.id ?? '') || target.id === '4ae2a643-b09e-43eb-816c-1e5557bef170' ||
    target.name !== workspaceName(receipt.runKey) || target.slug !== workspaceSlug(receipt.runKey)) fail('workspace_receipt_invalid')
  const switcher = await readJson(session, '/api/workspace/switcher')
  const account = switcher.accounts?.find(row => row.id === ALEX_OWNER_ID)
  const choices = Array.isArray(account?.choices) ? account.choices.filter(row => row.id === target.id && row.kind === 'team' && row.name === target.name) : []
  if (choices.length !== 1) fail('workspace_scope_mismatch')
  const switched = await rpc(session, 'workspace.switchWorkspace', [target.id])
  if (switched?.ok !== true || switched.data?.workspaceId !== target.id) fail('workspace_scope_mismatch')
  const [metadata, general, actual] = await Promise.all([
    readJson(session, '/api/workspace?workspace=' + target.id), rpc(session, 'workspace-settings.getWorkspaceGeneral', [target.id]),
    readJson(session, '/api/workspace/switcher'),
  ])
  if (actual.workspace?.id !== target.id || metadata.workspace?.id !== target.id || metadata.workspace.kind !== 'team' ||
    metadata.workspace.name !== target.name || metadata.currentUserId !== ALEX_OWNER_ID || general?.id !== target.id ||
    general.name !== target.name || general.slug !== target.slug || general.personal !== false) fail('workspace_scope_mismatch')
  if (metadata.role !== 'admin' || general.canEdit !== true || general.canTransfer !== true) fail('workspace_not_owned')
  if (!Array.isArray(metadata.members) || metadata.members.length !== 1 || metadata.members[0].userId !== ALEX_OWNER_ID ||
    metadata.members[0].role !== 'admin' || metadata.members[0].status !== 'active' ||
    !Array.isArray(metadata.invitations) || metadata.invitations.length !== 0) fail('workspace_not_fresh')
  return target
}

export async function setupWorkspace({ env = process.env, sessionProvider = alexSession, checkpoint = true } = {}) {
  const started = Date.now()
  const runKey = env.MIKKA_FIXTURE_RUN_KEY ?? (env.GITHUB_RUN_ID ? `gha-${env.GITHUB_RUN_ID}` : null)
  const report = { schemaVersion: 1, issue: 1506, phase: 'alex-1506-workspace', status: 'failed',
    runKey, ownerRef: ref(ALEX_OWNER_ID), applicationSha: null, workspace: null,
    creationAttempted: false, creationOutcome: 'not_attempted', modelMessages: 0, taskCreationRequests: 0,
    balanceWrites: 0, shares: { subscription: false, allowOthers: false, credit: false, subscriptionWrites: 0, creditWrites: 0 }, requests: [] }
  let requests = []
  const save = () => {
    report.requests = requests.map(({ path, method, status, headersMs }) => ({ path, method, status, headersMs }))
    if (!checkpoint) return
    mkdirSync(OUTPUT_DIR, { recursive: true })
    const path = OUTPUT_DIR + '/workspace.json'
    writeFileSync(path + '.tmp', JSON.stringify(report, null, 2) + '\n'); renameSync(path + '.tmp', path)
  }
  try {
    if (!RUN_KEY.test(runKey ?? '')) fail('workspace_run_key_required')
    const expectedSha = requireExactSha(env.MIKKA_ACCEPTANCE_SHA)
    report.applicationSha = expectedSha
    const name = workspaceName(runKey), slug = workspaceSlug(runKey)
    await sessionProvider(async session => {
      requests = session.requests
      if (session.identity?.userId !== ALEX_OWNER_ID) fail('acceptance_identity_mismatch')
      if (session.version?.build !== expectedSha) fail('acceptance_version_mismatch')
      const discover = async () => {
        const switcher = await readJson(session, '/api/workspace/switcher')
        const account = switcher.accounts?.find(row => row.id === ALEX_OWNER_ID)
        if (!Array.isArray(account?.choices)) fail('workspace_inventory_invalid')
        const matches = account.choices.filter(row => row.name === name)
        if (matches.length > 1) fail('workspace_ambiguous')
        if (matches.some(row => row.kind !== 'team' || !UUID.test(row.id ?? ''))) fail('workspace_scope_mismatch')
        return matches[0]?.id ?? null
      }
      let id = await discover()
      if (id) report.creationOutcome = 'existing_exact_run_name'
      else {
        report.creationAttempted = true; report.creationOutcome = 'unknown'; save()
        try {
          const result = await rpc(session, 'workspace.createWorkspace', [{ name, slug }])
          if (result?.ok !== true || !UUID.test(result.data?.workspaceId ?? '') || result.data?.slug !== slug) fail('workspace_create_invalid')
          id = result.data.workspaceId; report.creationOutcome = 'acknowledged'
        } catch {
          id = await discover().catch(() => null)
          if (!id) fail('workspace_creation_unknown')
          report.creationOutcome = 'recovered_after_unknown_no_retry'
        }
      }
      report.workspace = { id, ref: ref(id), kind: 'team', name, slug }; save()
      await selectOwnedWorkspace(session, report)
      const [bots, groups] = await Promise.all([
        readJson(session, '/api/bots'), readJson(session, '/api/conversations?workspaceId=' + id),
      ])
      if (!Array.isArray(bots) || bots.length !== 0 || !Array.isArray(groups?.conversations) || groups.conversations.length !== 0) fail('workspace_not_fresh')
      const beforeSub = await rpc(session, 'personal-policy.getSubscriptionShare', [id])
      const beforeCredit = await rpc(session, 'personal-policy.getCreditShare', [id])
      if (beforeSub?.personal !== false || beforeSub.allowed !== true || beforeCredit?.admin !== true || beforeCredit.canShare !== true ||
        beforeSub.allowOthers === true) fail('workspace_share_failed')
      if (beforeSub.shared !== true) {
        report.shares.subscriptionWrites++; save()
        await rpc(session, 'personal-policy.updateSubscriptionShare', [{ shared: true, allowOthers: false }, id])
      }
      if (beforeCredit.mine !== true) {
        report.shares.creditWrites++; save()
        await rpc(session, 'personal-policy.updateCreditShare', [true, id])
      }
      const [subscription, credit] = await Promise.all([
        rpc(session, 'personal-policy.getSubscriptionShare', [id]), rpc(session, 'personal-policy.getCreditShare', [id]),
      ])
      report.shares.subscription = subscription?.shared === true
      report.shares.allowOthers = subscription?.allowOthers === true
      report.shares.credit = credit?.mine === true
      if (!report.shares.subscription || report.shares.allowOthers || !report.shares.credit) fail('workspace_share_failed')
      if ((await readJson(session, '/api/version')).build !== expectedSha) fail('acceptance_version_changed')
      report.status = 'ready'; save()
    }, { expectedSha, deadlineAt: started + 180_000 })
    if (!requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)) fail('acceptance_signout_failed')
  } catch (error) { report.status = 'failed'; report.error = setupError(error) }
  report.signedOut = requests.some(row => row.path === '/mikka/api/auth/sign-out' && row.status >= 200 && row.status < 300)
  report.durationMs = Date.now() - started; save(); return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await setupWorkspace()
  console.log(JSON.stringify(report))
  if (report.status !== 'ready') process.exitCode = 1
}
