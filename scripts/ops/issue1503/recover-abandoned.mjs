#!/usr/bin/env node
/** Recover only the dispatch checkpoint of GHA 42280863233 through normal
 * Smoke HTTP APIs. This deliberately does not import full cleanup or touch
 * credentials, subscription shares, evidence issues, or machine resources. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { smokeSession, fail, SMOKE_ID } from './http.ts'
import { encode, decode } from '../../../lib/desktop-rpc/wire.ts'
import { removeModelOrderEntries, repositoryVerifyCommand, fileSpecification } from './delivery.mjs'

const WORKSPACE = '93f38d33-9447-4eaf-8a46-0d8889165bcd'
const REPOSITORY = 'alexj11324/Mikka-handoff'
const MARKER = '42280863233-1'
const ISSUE = 'c5551ab7-e251-489b-b17f-411680d63d2c'
const BOT = '6209f488-f494-43c8-b43b-567c5bf91f04'
const PROFILE = '2304a728-1105-43bf-8141-dcff2ff74bee'
const SHA = '2960d783f0196fed5375593d910a43430a101747'
const SOURCE = { kind: 'subscription', connectionId: '93b6ab23-900b-4e18-9ea0-baccf2d104ce' }
const MODEL = { harness: 'claude_code', model: 'claude-haiku-5-5', source: SOURCE }
const verificationPath = '/api/integrations/github/repositories/verification'
const check = (condition, code) => { if (!condition) fail(`recovery_${code}`) }
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value
const serialized = value => JSON.stringify(canonical(value))
const digest = value => createHash('sha256').update(value).digest('hex')
const same = (left, right) => serialized(left) === serialized(right)
const briefOrder = view => ({ location: view.location, preferredHarness: view.preferredHarness, autoModelRouting: view.autoModelRouting,
  customized: view.customized, entries: view.entries.map(({ harness, model, source }) => ({ harness, model, source })) })
const orderIdentity = view => ({ ...briefOrder(view), ids: view.entries.map(item => item.id) })
const safeCode = error => /^issue1503_[a-z0-9_]+$/.test(error?.message ?? '') ? error.message : 'issue1503_recovery_operation_failed'

export async function recoverAbandoned(env = process.env) {
  const reportPath = resolve(env.MIKKA_1503_RECOVERY_REPORT ?? 'issue1503-report/recovery.json')
  const report = { issue: 1503, phase: 'recover_abandoned', marker: MARKER, workspaceId: WORKSPACE, repository: REPOSITORY,
    issueId: ISSUE, identifier: 'F1503-1', startedAt: new Date().toISOString(), status: 'running', actions: [] }
  const checkpoint = async () => {
    await mkdir(resolve(reportPath, '..'), { recursive: true })
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
  let session
  try {
    // Missing/mismatched downloaded artifacts fail before login or mutations.
    report.stage = 'validate_checkpoint'
    const inputPath = resolve(env.MIKKA_1503_ABANDONED_REPORT ?? 'scripts/ops/issue1503/abandoned-delivery.json')
    check(inputPath !== reportPath && (await stat(inputPath)).size <= 1_000_000, 'checkpoint_file_invalid')
    const raw = await readFile(inputPath, 'utf8')
    const abandoned = JSON.parse(raw)
    check(abandoned.issue === 1503 && abandoned.phase === 'delivery' && abandoned.workspaceId === WORKSPACE
      && abandoned.repository === REPOSITORY && abandoned.marker === MARKER && abandoned.status === 'running'
      && abandoned.stage === 'dispatch' && abandoned.expectedSha === SHA && env.MIKKA_EXPECTED_DEPLOYMENT_SHA === SHA
      && !abandoned.completedAt && same(abandoned.selectedHarnesses, ['claude_code', 'codex'])
      && Array.isArray(abandoned.cleanup) && abandoned.cleanup.length === 0, 'checkpoint_scope_mismatch')
    check(Array.isArray(abandoned.cases) && abandoned.cases.length === 1, 'checkpoint_cases_mismatch')
    const active = abandoned.cases[0]
    const specifications = ['claude_code', 'codex'].map(harness => fileSpecification(MARKER, harness))
    const first = specifications[0]
    const installedCommand = repositoryVerifyCommand(specifications, first.path)
    check(active.harness === MODEL.harness && active.model === MODEL.model && active.status === 'running'
      && active.issueId === ISSUE && active.identifier === 'F1503-1' && active.expectedBranch === 'mikka/f1503-1'
      && active.profileId === PROFILE && active.botId === BOT && active.filePath === first.path
      && !active.taskId && Array.isArray(active.runs) && active.runs.length === 0, 'checkpoint_case_mismatch')
    check(abandoned.repositoryVerification?.originalConfigured === false && abandoned.repositoryVerification.originalCommandSha256 === null
      && same(abandoned.repositoryVerification.installed, [{ harness: MODEL.harness, requiredPath: first.path, commandSha256: digest(installedCommand) }]),
    'checkpoint_verification_mismatch')
    const original = briefOrder(abandoned.originalOrder)
    check(original.customized === true && digest(serialized({ ...original, customized: false }))
      === '528cdc4ffd615042e48ab112b9132779f328637e0469364e71f9cbc22a590792', 'checkpoint_original_order_mismatch')
    report.checkpointSha256 = digest(raw)
    report.originalOrderSha256 = digest(serialized(original))
    report.installedCommandSha256 = digest(installedCommand)
    await checkpoint()

    session = await smokeSession()
    const request = (path, init = {}) => session.request(path, { ...init,
      headers: { cookie: `mikka-workspace=${WORKSPACE}`, 'x-mikka-locale': 'en', ...init.headers } })
    const json = async (path, init) => {
      const response = await request(path, init)
      check(response.ok, `http_${response.status}`)
      const value = await response.json().catch(() => null)
      check(value !== null, 'http_json_invalid'); return value
    }
    const rpc = async (action, args) => {
      const result = await json('/api/desktop/rpc', session.post({ version: 1, action, args: encode(args) }))
      check(result.ok === true, 'rpc_failed')
      const value = decode(result.result)
      check(value?.ok !== false && !value?.error, 'rpc_action_failed')
      return value?.ok === true && Object.hasOwn(value, 'data') ? value.data : value
    }
    const pin = async () => check((await json('/api/version')).build === SHA, 'deployment_changed')
    const verifyValue = value => {
      check(value?.viewerId === SMOKE_ID && value.repository === REPOSITORY, 'verification_scope_mismatch')
      return value.verifyCommand
    }
    const verification = async () => verifyValue(await json(`${verificationPath}?repository=${encodeURIComponent(REPOSITORY)}`))
    const readOrder = async () => rpc('model-order.getModelOrder', [WORKSPACE])
    const readProfile = async () => (await json(`/api/factory/agent-profiles/${PROFILE}?workspaceId=${WORKSPACE}`)).profile
    const noWork = async () => {
      const tasks = await json(`/api/factory/tasks?issueId=${ISSUE}`)
      check(tasks.liveWorkspaceId === WORKSPACE && Array.isArray(tasks.tasks) && tasks.tasks.length === 0, 'factory_work_exists')
      const threads = await rpc('agents.pollIssueThreads', [ISSUE])
      check(threads.live?.workspaceId === WORKSPACE && Array.isArray(threads.threads) && threads.threads.length === 0, 'thread_work_exists')
      const chat = (await rpc('coordinator.syncCoordinatorChat', [BOT])).chat
      check(chat?.botId === BOT && chat.live?.ownerId === SMOKE_ID && chat.working === false, 'coordinator_still_working')
    }

    report.stage = 'preflight'
    await pin(); await noWork()
    const issues = await rpc('issues.listWorkspaceIssues', [WORKSPACE])
    check(Array.isArray(issues) && issues.some(item => item.id === ISSUE && item.identifier === 'F1503-1'), 'issue_scope_mismatch')
    const profile = await readProfile()
    check(profile?.id === PROFILE && profile.version === 1 && profile.enabled === true && profile.archivedAt === null
      && profile.name === `1503 ${MARKER} claude_code` && profile.harness === MODEL.harness && profile.effort === 'low'
      && same(profile.model, { mode: 'fixed', ...MODEL }) && same(profile.roles, ['execute', 'review', 'verify'])
      && Array.isArray(profile.skills) && profile.skills.length === 0 && /^[a-f0-9]{64}$/.test(profile.digest)
      && Date.parse(profile.createdAt) >= Date.parse(abandoned.startedAt), 'profile_mismatch')
    check(await verification() === installedCommand, 'verification_concurrent_change')
    let currentOrder = await readOrder()
    check(same(briefOrder(currentOrder), { location: 'cloud', preferredHarness: 'claude_code', autoModelRouting: false,
      customized: true, entries: [MODEL] }), 'model_order_concurrent_change')
    report.preflight = { factoryTasks: 0, issueThreads: 0, coordinatorWorking: false, profileId: PROFILE,
      profileVersion: profile.version, profileDigest: profile.digest, modelOrderSha256: digest(serialized(briefOrder(currentOrder))) }
    await checkpoint()

    report.stage = 'archive_profile'
    await pin(); await noWork()
    check(same(await readProfile(), profile), 'profile_concurrent_change')
    const archived = (await json(`/api/factory/agent-profiles/${PROFILE}`,
      { ...session.post({ workspaceId: WORKSPACE, version: profile.version }), method: 'DELETE' })).profile
    check(archived?.id === PROFILE && archived.version === 2 && archived.enabled === false && typeof archived.archivedAt === 'string'
      && /^[a-f0-9]{64}$/.test(archived.digest), 'profile_archive_mismatch')
    check(same(await readProfile(), archived), 'profile_archive_readback_mismatch')
    report.actions.push({ kind: 'profile_archived', id: PROFILE, fromVersion: 1, version: 2, beforeDigest: profile.digest, digest: archived.digest })
    await checkpoint()

    report.stage = 'restore_repository_verification'
    // This normal API exposes no CAS. Compare immediately before and after its
    // write; preserve any observed concurrent value by aborting without retry.
    check(await verification() === installedCommand, 'verification_concurrent_change')
    check(verifyValue(await json(verificationPath, { ...session.post({ repository: REPOSITORY, verifyCommand: null }), method: 'PATCH' })) === null,
      'verification_restore_mismatch')
    check(await verification() === null, 'verification_restore_readback_mismatch')
    report.actions.push({ kind: 'repository_verification_restored', configured: false, commandSha256: null })
    await checkpoint()

    report.stage = 'restore_model_order'
    const changeOrder = async change => {
      check(same(orderIdentity(await readOrder()), orderIdentity(currentOrder)), 'model_order_concurrent_change')
      const expected = briefOrder(currentOrder)
      if (change.kind === 'remove') expected.entries = currentOrder.entries.filter(item => item.id !== change.id).map(({ harness, model, source }) => ({ harness, model, source }))
      else if (change.kind === 'add') expected.entries.push(...change.entries)
      else if (change.kind === 'location') expected.location = change.location
      else if (change.kind === 'autoRouting') expected.autoModelRouting = change.enabled
      else if (change.kind === 'preferred') expected.preferredHarness = change.harness
      else fail('recovery_model_order_change_invalid')
      const updated = await rpc('model-order.changeModelOrder', [change, WORKSPACE])
      check(same(briefOrder(updated), expected), 'model_order_write_mismatch')
      currentOrder = updated
      return updated
    }
    currentOrder = await removeModelOrderEntries(currentOrder, changeOrder)
    await changeOrder({ kind: 'add', entries: original.entries })
    if (currentOrder.location !== original.location) await changeOrder({ kind: 'location', location: original.location })
    if (currentOrder.autoModelRouting !== original.autoModelRouting) await changeOrder({ kind: 'autoRouting', enabled: original.autoModelRouting })
    if (currentOrder.preferredHarness !== original.preferredHarness) await changeOrder({ kind: 'preferred', harness: original.preferredHarness })
    const restored = briefOrder(await readOrder())
    check(same(restored, original), 'model_order_restore_mismatch')
    report.actions.push({ kind: 'model_order_restored', location: restored.location, preferredHarness: restored.preferredHarness,
      autoModelRouting: restored.autoModelRouting, customized: restored.customized, entryCount: restored.entries.length,
      orderSha256: digest(serialized(restored)), exactOriginal: true })
    await checkpoint()

    report.stage = 'verify_recovery'
    await pin(); await noWork()
    check(await verification() === null && same(briefOrder(await readOrder()), original) && same(await readProfile(), archived), 'final_settings_changed')
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'; report.code = safeCode(error)
  } finally {
    await session?.close().catch(() => undefined)
    report.completedAt = new Date().toISOString()
    await checkpoint()
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await recoverAbandoned()
    console.log(JSON.stringify(report))
    if (report.status !== 'passed') process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ status: 'failed', code: safeCode(error) }))
    process.exitCode = 1
  }
}
