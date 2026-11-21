// No acceptance work is started here. Recovery uses the same human APIs and
// the same provider identity, restricted to this invocation's durable IDs.
import { createHash } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { cleanupCase, createSessionClient, restoreAcceptanceWorkspace, selectAcceptanceTeam, smokeAcceptanceAccount } from './cloud-startup.mjs'
import { createProductionCanary } from './task-secrets-production-canary.mjs'
import { cleanupIsolatedFixture } from './task-secrets-fixture.mjs'
import { createSecretBudget, readSecretJournal, writeSecretCheckpoint } from './task-secrets-journal.mjs'

const ORIGIN = 'https://app.aspectlylabs.com'
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i
const hash = value => createHash('sha256').update(value).digest('hex')
const check = (condition, code = 'cleanup') => { if (!condition) throw Error(`task_secrets_${code}`) }
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

function exactThread(value, record, workspaceId) {
  // getIssueThread deliberately projects no userId/issueId. Its arguments bind
  // the already verified Task; ownership and persisted live scope are public.
  check(value.thread?.id === record.runId && value.thread.ownedByCurrentUser === true
    && Array.isArray(value.thread.attempts) && value.thread.attempts.length === 1
    && value.thread.attempts[0].runId === record.runId
    && value.live?.issueWorkspaceId === workspaceId && Array.isArray(value.live.runs)
    && value.live.runs.length === 1 && value.live.runs[0].id === record.runId
    && value.live.runs[0].workspaceId === workspaceId)
}

/** This four-case canary never authorizes Factory work or a retry. Reuse the
 * normal retirement API while refusing the shared helper's broader discovery.
 */
export function exactCleanupClient(client, record, { ownerId, workspaceId }) {
  check(typeof ownerId === 'string' && ownerId.length > 0 && UUID.test(workspaceId ?? '') && UUID.test(record.issueId ?? ''))
  return { ...client,
    async json(path, init, ...rest) {
      if (path === `/api/factory/tasks?issueId=${record.issueId}` && !init?.method) {
        const value = await client.json(path, init, ...rest)
        check(value.issueId === record.issueId && Array.isArray(value.tasks) && value.tasks.length === 0)
        return value
      }
      if (path === `/api/live/ticket?workspace=${workspaceId}` && !init?.method) return client.json(path, init, ...rest)
      check(UUID.test(record.runId ?? '') && path === `/api/threads/${record.runId}/machine`
        && init?.method === 'POST' && JSON.parse(init.body).action === 'end')
      return client.json(path, init, ...rest)
    },
    async rpc(name, args, ...rest) {
      check(UUID.test(record.runId ?? ''))
      if (name === 'agents.stopRun') check(args.length === 1 && args[0] === record.runId)
      else check(['agents.getIssueThread', 'agents.getThreadMachine'].includes(name)
        && args.length === 2 && args[0] === record.issueId && args[1] === record.runId)
      const value = await client.rpc(name, args, ...rest)
      if (name === 'agents.getIssueThread') exactThread(value, record, workspaceId)
      return value
    },
  }
}

export async function cleanupTaskSecrets(options, { env = process.env, fetchImpl = fetch, now = Date.now,
  sessionClient = createSessionClient, selectTeam = selectAcceptanceTeam, cleanup = cleanupCase,
  cleanupFixture = cleanupIsolatedFixture, createCanary = createProductionCanary,
  readJournal = readSecretJournal, writeCheckpoint = writeSecretCheckpoint, WebSocketImpl = globalThis.WebSocket } = {}) {
  check(options.cleanupOnly, 'configuration')
  const journal = await readJournal(options)
  if (!journal) return { status: 'not_started', noJournal: true }
  const resources = journal.resources ?? {}, recovery = { status: 'running', startedAt: new Date(now()).toISOString(), errors: [], retained: [] }
  journal.recovery = recovery
  const path = resolve(dirname(options.reportPath), 'canary-journal.json')
  const save = () => { journal.checkpointAt = new Date(now()).toISOString(); return writeCheckpoint(path, journal) }
  // A disk error must not prevent retirement of already journaled resources.
  const saved = async () => { try { await save() } catch { recovery.errors.push({ step: 'journal', code: 'task_secrets_journal' }) } }
  const budget = createSecretBudget({ jobStartedAt: options.jobStartedAt, startedAt: new Date(now()).toISOString(), recovery: true }, { now })
  const client = sessionClient(ORIGIN, budget.fetch(fetchImpl))
  let loggedIn = false, ownerId, originalWorkspaceId, canary
  const step = async (name, action) => {
    try { budget.remaining('cleanup'); await action(); recovery[name] = true; await saved(); return true }
    catch { recovery.errors.push({ step: name, code: 'task_secrets_cleanup' }); await saved(); return false }
  }
  try {
    await saved()
    const needsAccount = resources.botId || journal.cases.length || journal.canary?.writes.some(write => write.operation === 'create')
    if (needsAccount) {
      check(journal.ownerHash && UUID.test(journal.workspaceId ?? ''), 'journal')
      const account = smokeAcceptanceAccount(env)
      const response = await client.request('/api/auth/sign-in/email', post({ ...account, rememberMe: false }))
      check(response.ok, 'identity'); loggedIn = true; await response.body?.cancel()
      const identity = await client.json('/api/auth/get-session'); ownerId = identity.user?.id
      check(typeof ownerId === 'string' && hash(ownerId).slice(0, 16) === journal.ownerHash
        && identity.user.email?.toLowerCase() === account.email.toLowerCase(), 'identity')
      const scope = await selectTeam(client, { ownerId, workspace: journal.workspaceId }, value => { originalWorkspaceId = value })
      check(scope.ownerId === ownerId && scope.workspaceId === journal.workspaceId, 'identity')
      if (journal.canary?.writes.some(write => write.operation === 'create') && !journal.canary.cleanup?.deleted) await step('canaryRecoveryOpened', async () => {
        canary = await createCanary({ client, ownerId, email: account.email, workspaceId: scope.workspaceId,
          sourceCommit: options.sourceCommit, fixtureId: journal.fixtureId, window: journal.canary.window, budget,
          connectionString: env.MIKKA_DATABASE_URL, recovery: journal.canary,
          pin: async () => check((await client.json('/api/version')).build === options.sourceCommit, 'build_mismatch'),
          persist: async evidence => { journal.canary = evidence; await saved() } }, { now })
      })
      let botStopped = !resources.botId
      if (resources.botId) botStopped = await step('botStopped', async () => {
        const bot = await client.json(`/api/bots/${resources.botId}`)
        check(bot.id === resources.botId && bot.name === resources.botName, 'identity')
        await client.rpc('coordinator.stopCoordinatorTurn', [resources.botId])
      })
      for (const record of journal.cases) {
        const unknown = (record.intents ?? []).filter(intent => intent.state !== 'responded'
          && !(intent.kind === 'profile_create' && record.profileId)
          && !(intent.kind === 'issue_create' && record.issueId)
          && !(intent.kind === 'dispatch' && record.issueId))
        if (unknown.length) recovery.retained.push({ caseId: record.caseId, reason: 'unresolved_creation_identity' })
        if (record.issueId && !record.cleanup?.taskDeleted) await step(`case_${record.caseId}`, async () => {
          check(botStopped)
          const { issue } = await client.rpc('issues.getIssue', [record.issueId])
          check(issue?.id === record.issueId && issue.userId === ownerId && issue.workspaceId === scope.workspaceId
            && issue.ownershipState === 'bound' && issue.title === record.title, 'identity')
          const { threads } = await client.rpc('agents.pollIssueThreads', [record.issueId])
          check(Array.isArray(threads) && threads.length <= 1 && threads.every(item => UUID.test(item.id)
            && item.ownedByCurrentUser === true && (!record.runId || item.id === record.runId)), 'identity')
          if (!record.runId && threads.length === 1) { record.runId = threads[0].id; record.recoveredAt = new Date(now()).toISOString(); await saved() }
          check(!record.runId || threads.length === 1, 'identity')
          if (!record.runId && record.intents?.some(intent => intent.kind === 'dispatch')) {
            recovery.retained.push({ caseId: record.caseId, reason: 'dispatch_result_unconfirmed' }); return
          }
          if (record.runId) {
            const detail = await client.rpc('agents.getIssueThread', [record.issueId, record.runId])
            exactThread(detail, record, scope.workspaceId)
            if (canary) {
              try { record.persistedRun = await canary.observeRun({ ...record, botId: resources.botId }, { budget, phase: 'cleanup' }) }
              catch { recovery.errors.push({ step: 'persisted_run_evidence', caseId: record.caseId, code: 'task_secrets_canary_run_evidence' }) }
              await saved()
            }
          }
          // No Task deletion until the separately owned object collector has
          // a complete receipt. Stop only this exact Task's runs and machines.
          record.cleanup = { status: 'running', errors: [] }
          await cleanup(exactCleanupClient(client, record, scope), record, 'cloud', { preserveIssue: true,
            timeoutMs: budget.remaining('cleanup', 60_000), WebSocketImpl, now })
          check(record.cleanup.status === 'passed' && !record.cleanup.errors.length)
          recovery.retained.push({ caseId: record.caseId, issueId: record.issueId, reason: 'task_objects_need_collection' })
          if (!record.nativePublicationCleanupConfirmed && record.phase !== 'revocation')
            recovery.retained.push({ caseId: record.caseId, reason: 'native_publication_cleanup_unconfirmed' })
          await saved()
        })
        if (record.profileId) await step(`profile_${record.caseId}`, async () => {
          const endpoint = `/api/factory/agent-profiles/${record.profileId}`
          const { profile } = await client.json(`${endpoint}?workspaceId=${scope.workspaceId}`)
          check(profile?.id === record.profileId && profile.name === record.profileName && profile.harness === record.harness, 'identity')
          if (profile.archivedAt && profile.enabled === false) return
          check(profile.version === record.profileVersion, 'identity')
          const value = await client.json(endpoint, { ...post({ workspaceId: scope.workspaceId, version: profile.version }), method: 'DELETE' })
          check(value.profile?.id === record.profileId && !!value.profile.archivedAt && value.profile.enabled === false)
        })
      }
      if (canary) await step('secretDeleted', async () => { check((await canary.close()).deleted) })
    }
    for (const intent of resources.intents ?? []) if (intent.state !== 'responded'
      && !(intent.kind === 'fixture_create' && resources.fixture)
      && !(intent.kind === 'bot_create' && resources.botId)) recovery.retained.push({ reason: 'unresolved_resource_creation', kind: intent.kind })
  } catch { recovery.errors.push({ step: 'identity_or_journal', code: 'task_secrets_cleanup' }) }
  finally {
    if (canary && !journal.canary.cleanup?.deleted) await step('secretDeleted', async () => { check((await canary.close()).deleted) })
    if (resources.fixture) await step('fixtureStopped', async () => {
      const result = await cleanupFixture(resources.fixture, env.E2B_API_KEY, { signal: budget.signal(), now })
      recovery.fixture = result
      check(result.stopped === true)
    })
    if (loggedIn) {
      if (originalWorkspaceId) await step('workspaceRestored', () => restoreAcceptanceWorkspace(client, ownerId, originalWorkspaceId))
      await step('signedOut', async () => { const response = await client.request('/api/auth/sign-out', post({})); check(response.ok); await response.body?.cancel() })
    }
    client.clear(); budget.close()
    recovery.finishedAt = new Date(now()).toISOString()
    recovery.status = recovery.errors.length || recovery.retained.length ? 'unconfirmed' : 'passed'
    await saved()
    if (recovery.errors.length) recovery.status = 'unconfirmed'
  }
  return recovery
}
