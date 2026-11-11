import { nativeCall, eveResponse } from '../../tests/support/eve-acceptance.mjs'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { CASES, ORIGIN, caseDocument, caseFingerprint, domainOptions, publicFailure, reviewGuard, runDomainAcceptance, runReceipt } from './work-domain-production.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const workspaceId = id(1), personalId = id(2), projectId = id(3), environmentId = id(4), botId = id(5)
const ownerId = 'PRIVATE_SHARED_ACCOUNT', adminId = 'PRIVATE_SHARED_ADMIN', sha = 'a'.repeat(40)
const source = item => id(item.id === 'claude' ? 40 : 41)
const scope = () => ({ workspaceId, projectId, environmentId, repositoryKey: 'v2/github.com/alexj11324/mikka', botId,
  models: { claude: { connectionId: id(40) }, codex: { connectionId: id(41) } } })
const env = (mode = 'preflight', selected = null) => ({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka',
  GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_SHA: sha, DOMAIN_MODEL_SHA: sha,
  DOMAIN_MODEL_MODE: mode, DOMAIN_MODEL_SCOPE: selected ? JSON.stringify(selected) : '', DOMAIN_MODEL_TIMEOUT_MS: '1000',
  SMOKE_OWNER_EMAIL: 'acceptance+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'PRIVATE_PASSWORD' })
const fixed = item => ({ mode: 'fixed', harness: item.harness, model: item.model,
  source: { kind: 'subscription', connectionId: source(item) } })
const apiKey = (models = ['deepseek-chat'], provider = 'deepseek', protocol = 'openai') => ({
  id: id(44), provider, protocol, baseUrl: provider === 'custom' ? 'https://provider.invalid/v1' : null, models, shared: false,
})
const now = () => Date.parse('2026-11-08T08:00:00Z')

test('workflow-only exact SHA and explicit strict scope fail before credentials', () => {
  assert.equal(domainOptions(env()).mode, 'preflight')
  assert.deepEqual(domainOptions(env('active', scope())).scope, scope())
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REF: 'refs/heads/feature' }, { GITHUB_EVENT_NAME: 'push' },
    { GITHUB_SHA: 'b'.repeat(40) }, { DOMAIN_MODEL_SHA: 'main' }, { GITHUB_REPOSITORY: 'foreign/Mikka' }])
    assert.throws(() => domainOptions({ ...env(), ...change }), { code: 'target_refused' })
  assert.throws(() => domainOptions(env('active')), { code: 'scope_required' })
  assert.throws(() => domainOptions(env('candidate')), { code: 'mode_invalid' })
  for (const change of [{ DOMAIN_OTHER_AUDIT_SHA: sha }, { DOMAIN_OTHER_AUDIT_LEASE: 'true' }])
    assert.throws(() => domainOptions({ ...env(), ...change }), { code: 'inputs_conflict' })
  assert.throws(() => domainOptions(env('provision', scope())), { code: 'scope_invalid' })
  for (const selected of [{ ...scope(), prompt: 'arbitrary' }, { ...scope(), projectId: 'name' },
    { ...scope(), repositoryKey: 'v2/github.com/../mikka' }, { ...scope(), models: { ...scope().models, deepseek: {} } },
    { ...scope(), models: { claude: { connectionId: id(40), model: 'pro' }, codex: scope().models.codex } }])
    assert.throws(() => domainOptions(env('active', selected)), { code: 'scope_invalid' })
})

test('domain acceptance rejects every non-default lease recovery request before credentials', () => {
  for (const recovery of [undefined, '', 'none'])
    assert.equal(domainOptions({ ...env(), DOMAIN_OTHER_AUDIT_RECOVERY_RUN: recovery }).mode, 'preflight')
  for (const recovery of ['42418118236', 'unexpected', 'false'])
    assert.throws(() => domainOptions({ ...env(), DOMAIN_OTHER_AUDIT_RECOVERY_RUN: recovery }), { code: 'inputs_conflict' })
})

test('automatic review permits only fixed selected small subscription sources before payment', () => {
  const state = { keys: { apiKeyAfterQuota: false, keys: [] }, management: { profiles: CASES.map(item => ({ enabled: true, harness: item.harness, model: fixed(item) })) } }
  assert.doesNotThrow(() => reviewGuard(state, scope()))
  for (const model of [{ mode: 'inherit' }, { ...fixed(CASES[0]), model: 'claude-opus-4-8' },
    { ...fixed(CASES[0]), source: { kind: 'api_key', keyId: id(45) } },
    { ...fixed(CASES[0]), source: { kind: 'subscription', connectionId: id(99) } }])
    assert.throws(() => reviewGuard({ ...state, management: { profiles: [{ enabled: true, model }] } }, scope()), { code: 'review_model_unbounded' })
  assert.throws(() => reviewGuard({ ...state, keys: { apiKeyAfterQuota: true, keys: [apiKey([CASES[0].model], 'anthropic')] } }, scope()), { code: 'paid_fallback_enabled' })
})

test('useful titles remain clean while deterministic internal metadata binds SHA, scope and model', () => {
  const options = domainOptions(env('active', scope())), a = caseDocument(options, CASES[0])
  assert.equal(a.fingerprint, caseFingerprint(options, CASES[0]))
  assert.match(JSON.stringify(a.content), /内部验收引用/)
  assert.match(JSON.stringify(a.content), /实际 checkout commit/)
  assert.ok(!CASES[0].title.includes(sha))
  assert.notEqual(a.fingerprint, caseFingerprint({ ...options, sha: 'b'.repeat(40) }, CASES[0]))
  assert.notEqual(a.fingerprint, caseFingerprint({ ...options, scope: { ...scope(), projectId: id(99) } }, CASES[0]))
  assert.notEqual(a.fingerprint, caseFingerprint(options, CASES[1]))
})

function fixture({ badProject = false, badEnvironment = false, unsafeProfile = false, paidFallback = false,
  quotaCase, refuseCase, wrongRunModel = false, failMachine = false, changedBuild = false,
  emptyDomain = false, workspaceRole = 'member', loseEnvironmentResponse = false, uncertainDispatch, keyCatalog, settledBusinessStatus = 'todo',
  missingSource, chatModel = 'claude', foreignRun = false, foreignEpoch = false, changedEpoch = false,
  loseProfileResponse = false, failProfileRecovery = false, dispatchAdvanceMs = 0, foreignProducerProfile = false,
  missingDispatchReference = false, foreignDispatchEvent = false, requestKeyPreview = false, presentationOverride = {} } = {}) {
  const calls = [], issues = [], profiles = [], runs = [], factories = [], machineEnds = []
  const projects = emptyDomain ? [] : [{ id: projectId, workspaceId: badProject ? id(99) : workspaceId, revision: 1,
    archivedAt: null, name: 'PRIVATE_PROJECT_NAME', userId: ownerId, leadUserId: ownerId, memberIds: [ownerId], issueIds: [] }]
  let workspace = personalId, selectedRun, versions = 0, elapsed = 0
  const factoryReads = new Map()
  if (unsafeProfile) profiles.push({ id: id(80), version: 1, digest: 'c'.repeat(64), enabled: true, harness: 'auto',
    model: { mode: 'inherit' }, instructions: 'PRIVATE_PROFILE_INSTRUCTIONS', archivedAt: null })
  const environments = emptyDomain ? [] : [{ id: environmentId, workspaceId, revision: 2, archivedAt: null, name: 'PRIVATE_ENVIRONMENT_NAME',
      configuration: { runtime: 'cloud', harness: badEnvironment ? 'cursor' : 'any', setup: { approved: true, commands: ['PRIVATE_SETUP'] },
        variables: { PRIVATE_ENV: 'PRIVATE_ENV_VALUE' }, secretIds: ['PRIVATE_SECRET_REFERENCE'], repositoryKeys: [] } }]
  const bindings = new Map(emptyDomain ? [] : [[projectId, {
    repositories: [{ repositoryKey: scope().repositoryKey, baseBranch: 'main', environmentId, isPrimary: true }],
    environmentBindings: [{ environmentId, isDefault: true }],
  }]])
  const resources = selectedProject => ({ policy: { mode: 'inherit', repositoryKeys: [], revision: 0 }, environments,
    ...(bindings.get(selectedProject) ?? { repositories: [], environmentBindings: [] }) })
  const management = () => ({ profiles: profiles.filter(row => !row.archivedAt), catalog: { models: CASES.map(item => ({
    harness: item.harness, model: item.model, source: fixed(item).source, available: quotaCase !== item.id,
  })) } })
  const thread = run => ({ id: run.id, status: 'succeeded', ownedByCurrentUser: true,
    detail: { summary: 'PRIVATE_REPORT_CONTENT '.repeat(10) }, attempts: [{ runId: run.id, status: 'succeeded' }], latestRunId: run.id })
  const evidence = run => ({ run: { id: run.id, issueId: run.issueId, status: 'succeeded', botId,
    harness: run.item.harness, model: wrongRunModel ? 'PRIVATE_UNEXPECTED_MODEL' : run.item.model,
    credentialType: 'subscription', subscriptionRoute: run.item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli',
    agentProfile: { profileId: foreignProducerProfile ? id(989) : run.profile.id, version: run.profile.version, digest: run.profile.digest, source: 'explicit' },
    executionIdentity: { version: 1, requester: ownerId, executionPrincipal: ownerId, outputOwner: ownerId,
      botId, botOwner: ownerId, workspaceId, personalResourcePolicy: 'requester_only',
      resourceBindings: [{ kind: 'device', id: id(900), ownerId, access: 'owner' },
        { kind: 'subscription', id: id(901), ownerId: adminId, access: 'workspace_share', revision: '1' }],
      billingAccount: { model: { kind: 'subscription', resourceId: id(901), ownerId: adminId },
        runtime: { kind: 'e2b', resourceId: ownerId, ownerId } } } },
    private: 'PRIVATE_EVIDENCE_EXTRA', artifacts: [{ content: 'PRIVATE_ARTIFACT' }] })
  const rpc = value => Response.json({ version: 1, ok: true, result: value })
  const fetchImpl = async (url, init = {}) => {
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    const path = url.pathname.slice('/mikka'.length), body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, query: url.search, method: init.method ?? 'GET', body })
    if (path === '/api/version') return Response.json({ build: changedBuild && versions++ > 0 ? 'b'.repeat(40) : sha })
    if (path === '/api/auth/sign-in/email') {
      assert.equal(body.email, env().SMOKE_OWNER_EMAIL)
      assert.equal(body.password, 'PRIVATE_PASSWORD')
      return Response.json({}, { headers: { 'set-cookie': 'session=PRIVATE_COOKIE; Path=/; Secure; HttpOnly' } })
    }
    assert.match(init.headers.cookie ?? '', /session=PRIVATE_COOKIE/)
    if (path === '/api/auth/get-session') return Response.json({ user: { id: ownerId, email: env().SMOKE_OWNER_EMAIL } })
    if (path === '/api/auth/sign-out') return Response.json({}, { headers: { 'set-cookie': 'session=; Max-Age=0' } })
    if (path === '/api/workspace') {
      const current = url.searchParams.get('workspace') ?? workspace
      return Response.json({ currentUserId: ownerId, workspace: { id: current, kind: current === workspaceId ? 'team' : 'personal' },
        choices: [{ id: personalId, kind: 'personal' }, { id: workspaceId, kind: 'team' }], role: workspaceRole,
        members: [{ userId: adminId, email: 'alex@acme.aspectlylabs.com', role: 'admin', status: 'active' }] })
    }
    if (path === '/api/integrations/github') return Response.json({ viewerId: ownerId, connected: true,
      repositories: [{ fullName: 'alexj11324/Mikka', private: 'PRIVATE_REPOSITORY_EXTRA' }] })
    if (path === '/api/settings/api-keys') return Response.json({ apiKeyAfterQuota: paidFallback,
      keys: keyCatalog ?? [{ ...apiKey(paidFallback ? [CASES[0].model] : undefined, paidFallback ? 'anthropic' : undefined), token: 'PRIVATE_API_KEY' }] })
    if (path === '/api/factory/agent-profiles') {
      if (!body) return Response.json(management())
      assert.equal(body.workspaceId, workspaceId)
      assert.match(body.requestId, /^[0-9a-f-]{36}$/)
      assert.equal(body.profile.model.mode, 'fixed')
      assert.equal(body.profile.model.source.kind, 'subscription')
      let profile = profiles.find(row => row.id === body.requestId)
      if (!profile) {
        profile = { ...body.profile, id: body.requestId, version: 1, digest: 'c'.repeat(64), archivedAt: null }
        profiles.push(profile)
      }
      if (loseProfileResponse) throw new Error('PRIVATE profile response lost after commit')
      return Response.json({ profile })
    }
    if (path.startsWith('/api/factory/agent-profiles/')) {
      const profile = profiles.find(row => path.endsWith('/' + row.id)); assert.ok(profile)
      if (!init.method || init.method === 'GET') {
        assert.equal(url.searchParams.get('workspaceId'), workspaceId)
        return failProfileRecovery ? Response.json({ error: 'agentProfileUnavailable' }, { status: 503 }) : Response.json({ profile })
      }
      assert.equal(init.method, 'DELETE', 'existing profiles are never patched')
      assert.equal(body.version, profile.version); profile.archivedAt = new Date(now()).toISOString()
      return Response.json({ profile })
    }
    if (path === '/api/issues/search') return Response.json({ items: issues.filter(issue => issue.title.includes(url.searchParams.get('q')))
      .map(issue => ({ id: issue.id, ownerId: issue.userId, title: issue.title })), nextCursor: null, truncated: false })
    if (path === '/api/agents/eve/v1/session') return Response.json({ ok: true, sessionId: 'wrun_domain' })
    if (/^\/api\/agents\/eve\/v1\/session\/[^/]+\/stream$/.test(path)) {
      elapsed += dispatchAdvanceMs
      const selected = selectedRun
      const input = { issueId: selected.issueId, profileId: selected.profile.id,
        ...(!missingDispatchReference ? { requestKey: selected.requestKey, ...(!requestKeyPreview ? { note: selected.note } : {}) } : {}) }
      const events = nativeCall('call-' + selected.issueId, input, { runId: selected.id }, selected.refused ? 'subscriptionQuotaExhausted' : undefined)
      if (foreignDispatchEvent) events.unshift(...nativeCall('unrelated', { issueId: selected.issueId, profileId: selected.profile.id, requestKey: id(999), note: '[1687:' + id(999) + '] other submission' }, { runId: runs.find(run => run.issueId === selected.issueId && run.foreign).id }))
      return eveResponse(events)
    }
    if (path === '/api/factory/tasks') {
      const issueId = url.searchParams.get('issueId')
      return Response.json({ issueId, liveWorkspaceId: workspaceId, tasks: factories.filter(row => row.task.issueId === issueId).map(row => row.task) })
    }
    if (path.startsWith('/api/factory/tasks/')) {
      const snapshot = factories.find(row => path.endsWith('/' + row.task.id)); assert.ok(snapshot)
      if (body) {
        assert.equal(body.action, 'cancel'); assert.equal(body.binding.revision, snapshot.task.revision)
        assert.ok(snapshot.attempts.every(attempt => attempt.output.requestEpoch === snapshot.task.sourceEventId), 'cancel must never revoke a foreign epoch')
        snapshot.task.status = 'cancelled'
      } else {
        factoryReads.set(snapshot.task.id, (factoryReads.get(snapshot.task.id) ?? 0) + 1)
        if (changedEpoch && factoryReads.get(snapshot.task.id) === 2) {
          snapshot.task.sourceEventId = id(990); snapshot.task.revision++
          const original = runs.find(row => row.issueId === snapshot.task.issueId && !row.foreign)
          const other = { ...original, id: id(1000 + runs.length), foreign: true }; runs.push(other)
          snapshot.attempts.push({ id: id(1100 + runs.length), taskId: snapshot.task.id, runId: other.id, output: { requestEpoch: snapshot.task.sourceEventId } })
        }
      }
      return Response.json(snapshot)
    }
    if (path.startsWith('/api/runs/')) {
      assert.ok(path.endsWith('/evidence'))
      const run = runs.find(row => path.includes(row.id)); assert.ok(run)
      return Response.json(evidence(run))
    }
    if (path.startsWith('/api/threads/')) {
      const run = runs.find(row => path.includes(row.id)); assert.ok(run)
      assert.deepEqual(body, { action: 'end' }); machineEnds.push(run.id)
      return Response.json({ runId: run.id, state: failMachine ? 'error' : 'ended' })
    }
    if (path === '/api/rpc') {
      assert.equal(init.headers['x-mikka-rpc'], '1')
      const { action, args } = body
      if (action === 'workspace.switchWorkspace') { workspace = args[0]; return rpc({ ok: true, data: { workspaceId: workspace } }) }
      if (action === 'projects.listWorkspaceProjects') return rpc(projects)
      if (action === 'project-resources.listProjectResources') return rpc(resources(args[1]))
      if (action === 'projects.saveProject') {
        assert.equal(args[0].id, undefined); assert.equal(args[0].workspaceId, workspaceId)
        assert.equal(args[0].leadUserId, ownerId); assert.deepEqual(args[0].memberIds, [ownerId])
        const project = { ...args[0], id: id(600 + projects.length), userId: ownerId, revision: 1, issueIds: [], archivedAt: null }
        projects.push(project); return rpc({ project })
      }
      if (action === 'projects.updateProjectProperties') {
        const project = projects.find(row => row.id === args[0].id); assert.ok(project)
        assert.equal(args[0].revision, project.revision); assert.equal(project.userId, ownerId)
        assert.deepEqual(Object.keys(args[0].changes), ['description'])
        Object.assign(project, args[0].changes); project.revision++; return rpc({ project })
      }
      if (action === 'project-resources.saveEnvironment') {
        assert.equal(workspaceRole, 'admin'); assert.equal(args[0].id, undefined)
        assert.deepEqual(args[0].configuration, { runtime: 'cloud', harness: 'any', variables: {}, secretIds: [], repositoryKeys: [scope().repositoryKey] })
        const environment = { ...args[0], id: id(700 + environments.length), revision: 1, archivedAt: null }
        environments.push(environment)
        if (loseEnvironmentResponse) throw new Error('PRIVATE lost response after successful create')
        return rpc({ id: environment.id, revision: 1 })
      }
      if (action === 'project-resources.saveProjectResources') {
        const project = projects.find(row => row.id === args[0].projectId); assert.ok(project)
        assert.equal(workspaceRole, 'admin'); assert.equal(args[0].revision, project.revision)
        assert.ok(!bindings.has(project.id), 'an existing binding must never be overwritten')
        assert.deepEqual(args[0].environmentIds, [args[0].defaultEnvironmentId])
        bindings.set(project.id, { repositories: args[0].repositories, environmentBindings: [{ environmentId: args[0].defaultEnvironmentId, isDefault: true }] })
        project.revision++; return rpc({ revision: project.revision })
      }
      if (action === 'bots.listBots') return rpc([{ id: botId, name: 'PRIVATE_BOT_NAME' }])
      if (action === 'model-order.getModelOrder') return rpc({ candidates: CASES.filter(item => item.id !== missingSource).map(item => ({ harness: item.harness, model: item.model,
        source: fixed(item).source, credentialOwnerId: adminId })), entries: [] })
      if (action === 'execution-settings.getBotModelMenu') return rpc({ current: { kind: 'subscription', chosen: true,
        provider: chatModel, modelId: CASES.find(item => item.id === chatModel).model, available: true } })
      if (action === 'coordinator.getCoordinatorChat') return rpc({ botId, enabled: true, working: false })
      if (action === 'issues.saveIssue') {
        const issue = { ...args[0], id: id(200 + issues.length), userId: ownerId, revision: 1,
          projectId: null, identifier: 'WS-1687-' + (issues.length + 1) }
        issues.push(issue); return rpc({ issue })
      }
      if (action === 'projects.moveIssueToProject') {
        const issue = issues.find(row => row.id === args[0].issueId); assert.ok(issue)
        assert.equal(args[0].workspaceId, workspaceId); assert.equal(args[0].revision, issue.revision)
        issue.projectId = args[0].projectId; issue.revision++; return rpc({ issue })
      }
      if (action === 'issues.getIssue') { const issue = issues.find(row => row.id === args[0]); assert.ok(issue); return rpc({ issue }) }
      if (action === 'task-domain.getTaskPresentation') {
        const issue = issues.find(row => row.id === args[0]); assert.ok(issue)
        const closed = ['done', 'canceled', 'duplicate'].includes(issue.status)
        return rpc({ version: 1, primaryStatus: issue.status, runStatus: 'succeeded', factoryStage: 'handoff', completion: null,
          state: closed ? issue.status : 'waiting', reason: closed ? null : 'pr_review', blockedBy: null,
          group: closed ? 'done' : 'pending', needsAction: closed ? null : 'pr_review', blockedReason: null, ...presentationOverride })
      }
      if (action === 'coordinator.sendCoordinatorMessage') {
        const issue = issues.find(row => args[0].includes(row.id)); assert.ok(issue)
        assert.ok(projects.some(row => row.id === issue.projectId))
        assert.deepEqual(args[4], { kind: 'cloud' }); assert.match(args[0], /"readOnly":true/)
        const profile = profiles.find(row => row.id === args[8]); assert.ok(profile)
        const item = CASES.find(row => row.harness === profile.harness); assert.ok(item)
        const start = args[0].indexOf('{"issueId"'), end = args[0].indexOf('}。', start) + 1
        const dispatchInput = JSON.parse(args[0].slice(start, end))
        assert.equal(dispatchInput.requestKey, args[3]); assert.ok(dispatchInput.note.startsWith('[1687:' + args[3] + '] '))
        selectedRun = { id: id(300 + runs.length), issueId: issue.id, item, profile, refused: refuseCase === item.id,
          note: dispatchInput.note, requestKey: dispatchInput.requestKey }
        if (!selectedRun.refused) {
          issue.status = settledBusinessStatus
          runs.push(selectedRun)
          const taskId = id(400 + factories.length), sourceEventId = id(800 + factories.length)
          const snapshot = { task: { id: taskId, issueId: issue.id, workspaceId, userId: ownerId, botId, sourceEventId,
            revision: 3, stage: 'approval', status: 'waiting' }, attempts: [{ id: id(500 + factories.length), taskId,
            runId: selectedRun.id, output: { requestEpoch: sourceEventId } }] }
          factories.push(snapshot)
          if (foreignRun || foreignEpoch) {
            const other = { ...selectedRun, id: id(1000 + runs.length), foreign: true }; runs.push(other)
            if (foreignEpoch) snapshot.attempts.push({ id: id(1100 + runs.length), taskId, runId: other.id, output: { requestEpoch: id(991) } })
          }
        }
        if (uncertainDispatch === item.id) throw new Error('PRIVATE transport failure after successful dispatch')
        return rpc({ queued: true })
      }
      if (action === 'agents.pollIssueThreads') return rpc({ threads: runs.filter(row => row.issueId === args[0]).map(thread) })
      if (action === 'agents.getIssueThread') {
        const run = runs.find(row => row.id === args[1] && row.issueId === args[0]); assert.ok(run)
        return rpc({ thread: thread(run), chunks: [
          { chunk: { type: 'data-run-stage', data: { stage: 'repository', ok: true } } },
          { chunk: { type: 'tool-output-available', output: 'PRIVATE_TOOL_OUTPUT' } },
          ...Array.from({ length: 20 }, () => ({ chunk: { type: 'text-delta', delta: '报告正文片段。' } })),
        ], live: { runs: [{ id: run.id, workspaceId }] } })
      }
      if (action === 'agents.getThreadMachine') return rpc({ kind: 'cloud', state: 'ended', cloud: null })
      assert.fail('Unexpected RPC ' + action)
    }
    assert.fail('Unexpected HTTP ' + path)
  }
  return { calls, issues, profiles, runs, factories, machineEnds, projects, environments, bindings, fetchImpl, evidence,
    run: options => runDomainAcceptance({ env: env(options?.mode ?? 'active', options?.scope === undefined ? scope() : options.scope), fetchImpl,
      now: () => now() + elapsed, WebSocketImpl: class { constructor() { assert.fail('A terminal fixture must not open a socket') } } }) }
}

test('preflight uses the existing team account, exports only closed candidates and sends no task/model mutation', async () => {
  const f = fixture(), report = await f.run({ mode: 'preflight', scope: null })
  assert.equal(report.status, 'preflight_complete')
  assert.equal(report.preflight.workspaceId, workspaceId)
  assert.equal(report.preflight.selectionRequired, true)
  assert.deepEqual(report.preflight.sources.map(row => row.connectionId), [id(40), id(41)])
  assert.equal(f.issues.length, 0); assert.equal(f.profiles.length, 0); assert.equal(f.runs.length, 0)
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
  assert.equal(report.cleanup.workspaceRestored, true); assert.equal(report.cleanup.sessionClosed, true)
  assert.ok(!f.calls.some(call => /sendCoordinator|saveIssue|chooseBotModel|changeModelOrder|delete/i.test(call.body?.action ?? '')))
})

const provisionScope = () => {
  const { projectId: _project, environmentId: _environment, ...selected } = scope()
  return { ...selected, baseBranch: 'main' }
}
test('provision creates retained useful objects only after full admission, then returns a real active scope', async () => {
  const f = fixture({ emptyDomain: true, workspaceRole: 'admin' })
  const report = await f.run({ mode: 'provision', scope: provisionScope() })
  assert.equal(report.status, 'provisioned', JSON.stringify(report))
  assert.equal(f.projects.length, 1); assert.equal(f.environments.length, 1)
  assert.equal(f.issues.length, 0); assert.equal(f.runs.length, 0); assert.equal(f.profiles.length, 0)
  assert.equal(report.provision.objectsRetained, true)
  const selected = report.provision.activeScope
  assert.equal(selected.projectId, f.projects[0].id); assert.equal(selected.environmentId, f.environments[0].id)
  assert.equal(f.bindings.get(selected.projectId).repositories[0].baseBranch, 'main')
  assert.equal(f.projects[0].leadUserId, ownerId); assert.deepEqual(f.projects[0].memberIds, [ownerId])
  const before = f.calls.filter(call => /saveProject|saveEnvironment|updateProject/.test(call.body?.action ?? '')).length
  assert.equal((await f.run({ mode: 'provision', scope: provisionScope() })).status, 'provisioned')
  assert.equal(f.calls.filter(call => /saveProject|saveEnvironment|updateProject/.test(call.body?.action ?? '')).length, before, 'complete rerun performs no writes')
  assert.equal((await f.run({ mode: 'active', scope: selected })).status, 'execution_observed_pending_snapshot_review')
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})

test('provision reuses only an explicitly selected compatible Environment and leaves every prior object intact', async () => {
  const f = fixture({ emptyDomain: true, workspaceRole: 'admin' })
  const existing = { id: id(799), workspaceId, revision: 7, archivedAt: null, name: 'Existing review environment',
    configuration: { runtime: 'cloud', harness: 'any', variables: {}, secretIds: [], repositoryKeys: [] } }
  f.environments.push(existing)
  const before = structuredClone(existing)
  const report = await f.run({ mode: 'provision', scope: { ...provisionScope(), environmentId: existing.id } })
  assert.equal(report.status, 'provisioned', JSON.stringify(report))
  assert.equal(f.environments.length, 1); assert.deepEqual(existing, before)
  assert.equal(report.provision.activeScope.environmentId, existing.id)
  assert.ok(!f.calls.some(call => call.body?.action === 'project-resources.saveEnvironment'))
})

for (const [label, changes, code] of [['non-admin actor', {}, 'provision_permission'],
  ['missing selected source', { workspaceRole: 'admin', missingSource: 'claude' }, 'source_missing'],
  ['unbounded reviewer', { workspaceRole: 'admin', unsafeProfile: true }, 'review_model_unbounded']]) {
  test('provision refuses ' + label + ' before creating any business object', async () => {
    const f = fixture({ emptyDomain: true, ...changes }), report = await f.run({ mode: 'provision', scope: provisionScope() })
    assert.equal(report.failure?.code, code, JSON.stringify(report))
    assert.equal(f.projects.length, 0); assert.equal(f.environments.length, 0)
    assert.ok(!f.calls.some(call => /saveProject|saveEnvironment|sendCoordinator/.test(call.body?.action ?? '')))
  })
}

test('quota on one subscription does not block zero-prompt provisioning or the other subscription execution', async () => {
  const f = fixture({ emptyDomain: true, workspaceRole: 'admin', quotaCase: 'claude' })
  const provisioned = await f.run({ mode: 'provision', scope: provisionScope() })
  assert.equal(provisioned.status, 'provisioned', JSON.stringify(provisioned))
  assert.deepEqual(provisioned.provision.models, [{ case: 'claude', available: false }, { case: 'codex', available: true }])
  assert.equal(f.runs.length, 0)
  const report = await f.run({ mode: 'active', scope: provisioned.provision.activeScope })
  assert.equal(report.cases[0].failure?.code, 'source_unavailable')
  assert.equal(report.cases[1].status, 'execution_observed')
})

test('a lost Environment receipt blocks blind retries; an explicit authorized ID safely resumes the retained Project', async () => {
  const f = fixture({ emptyDomain: true, workspaceRole: 'admin', loseEnvironmentResponse: true })
  const first = await f.run({ mode: 'provision', scope: provisionScope() })
  assert.equal(first.status, 'failed'); assert.equal(first.provision.projectId, f.projects[0].id)
  assert.equal(f.projects.length, 1); assert.equal(f.environments.length, 1)
  const repeated = await f.run({ mode: 'provision', scope: provisionScope() })
  assert.equal(repeated.failure?.code, 'provision_ambiguous')
  assert.equal(f.projects.length, 1); assert.equal(f.environments.length, 1)
  const recovered = await f.run({ mode: 'provision', scope: { ...provisionScope(), environmentId: f.environments[0].id } })
  assert.equal(recovered.status, 'provisioned', JSON.stringify(recovered))
  assert.equal(recovered.provision.projectId, first.provision.projectId)
  assert.equal(f.environments.length, 1)
})

test('a changed retained resource binding is rejected rather than overwritten by provisioning', async () => {
  const f = fixture({ emptyDomain: true, workspaceRole: 'admin' })
  const first = await f.run({ mode: 'provision', scope: provisionScope() })
  f.bindings.get(first.provision.projectId).repositories[0].baseBranch = 'different-existing-branch'
  const before = f.calls.filter(call => call.body?.action === 'project-resources.saveProjectResources').length
  const repeated = await f.run({ mode: 'provision', scope: provisionScope() })
  assert.equal(repeated.failure?.code, 'provision_conflict')
  assert.equal(f.calls.filter(call => call.body?.action === 'project-resources.saveProjectResources').length, before)
  assert.equal(f.bindings.get(first.provision.projectId).repositories[0].baseBranch, 'different-existing-branch')
})

test('active runs one useful retained Task per subscription through canonical Project and real observer helpers', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
  assert.equal(report.cases.length, 2); assert.equal(f.issues.length, 2); assert.equal(f.runs.length, 2)
  assert.deepEqual(f.machineEnds, f.runs.map(row => row.id))
  assert.ok(f.profiles.every(profile => profile.archivedAt))
  assert.ok(report.cases.every(row => row.status === 'execution_observed' && row.repositoryObserved && row.toolObserved && row.reportObserved))
  assert.ok(report.cases.every(row => row.factory[0].stage === 'approval' && row.factory[0].status === 'waiting'))
  assert.ok(report.cases.every(row => row.taskState.businessStatus === 'todo' && row.taskState.primaryStatus === 'todo'
    && row.taskState.runStatus === 'succeeded' && row.taskState.factoryStage === 'handoff' && row.taskState.completion === null
    && row.taskState.state === 'waiting' && row.taskState.reason === 'pr_review' && row.taskState.group === 'pending'
    && row.taskState.blockedBy === null && row.taskState.needsAction === 'pr_review' && row.taskState.blockedReason === null))
  assert.equal(report.coverage.environmentSetup, 'not_exercised_readonly')
  assert.equal(report.coverage.frozenSnapshot, 'requires_separate_authorized_app_read')
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
  assert.ok(!f.calls.some(call => call.body?.action === 'issue-operations.setIssueDeleted' || call.body?.action === 'execution-settings.chooseBotModel'))
  const submissions = f.calls.filter(call => call.body?.action === 'coordinator.sendCoordinatorMessage')
  assert.equal(submissions.length, 2)
  assert.ok(submissions.every(call => /dispatch_run/.test(call.body.args[0])))
  assert.deepEqual(f.issues.map(issue => issue.title), CASES.map(item => item.title))
})

test('settled state reports the actual business status separately from run success and an unaccepted handoff', async () => {
  const f = fixture({ settledBusinessStatus: 'review' }), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
  assert.ok(report.cases.every(row => row.taskState.businessStatus === 'review' && row.taskState.primaryStatus === 'review'
    && row.taskState.runStatus === 'succeeded' && row.taskState.completion === null))
  assert.ok(!f.calls.some(call => /approval|accept/i.test(call.path)))
})

for (const [label, options] of [
  ['successful Run incorrectly closes an open Task', { presentationOverride: { state: 'done', group: 'done' } }],
  ['canonical fields are missing', { presentationOverride: { state: undefined, reason: undefined, blockedBy: undefined, group: undefined } }],
  ['closed Task retains an open display state', { settledBusinessStatus: 'done', presentationOverride: { state: 'waiting', group: 'pending' } }],
  ['human approval still carries obsolete quota labels', { presentationOverride: { state: 'waiting', reason: 'approval', needsAction: 'quota', blockedReason: 'quota' } }],
]) {
  test('state receipt rejects ' + label + ' and still cleans up only its retained execution', async () => {
    const f = fixture(options), report = await f.run()
    assert.ok(report.cases.every(row => row.status === 'failed' && row.failure.code === 'response_invalid'
      && row.failure.detail === 'task_presentation' && row.cleanup.status === 'passed'), JSON.stringify(report))
    assert.equal(f.issues.length, 2)
    assert.deepEqual(f.machineEnds, f.runs.map(row => row.id))
  })
}

for (const status of ['done', 'canceled', 'duplicate']) {
  test('state receipt preserves actual business closure ' + status + ' without inferring delivery', async () => {
    const f = fixture({ settledBusinessStatus: status }), report = await f.run()
    assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
    assert.ok(report.cases.every(row => row.taskState.state === status && row.taskState.group === 'done'
      && row.taskState.reason === null && row.taskState.completion === null))
  })
}

test('live receipts accept current lifecycle states without mistaking preparation or input wait for terminal success', async () => {
  const f = fixture(); await f.run()
  const evidence = f.evidence(f.runs[0])
  for (const status of ['queued', 'preparing', 'running', 'paused', 'waiting_input', 'finishing']) {
    evidence.run.status = status
    const receipt = runReceipt(evidence, { ownerId, adminId, botId }, scope(), f.runs[0].issueId)
    assert.equal(receipt.status, status)
  }
  evidence.run.status = 'PRIVATE_UNKNOWN_STATE'
  assert.throws(() => runReceipt(evidence, { ownerId, adminId, botId }, scope(), f.runs[0].issueId), { code: 'run_model_mismatch' })
})

test('workflow rerun detects retained internal fingerprints and never submits or creates duplicate Tasks', async () => {
  const f = fixture()
  assert.equal((await f.run()).status, 'execution_observed_pending_snapshot_review')
  const before = f.calls.filter(call => call.body?.action === 'coordinator.sendCoordinatorMessage').length
  const repeated = await f.run()
  assert.ok(repeated.cases.every(row => row.failure.code === 'case_already_exists'))
  assert.equal(f.issues.length, 2)
  assert.equal(f.calls.filter(call => call.body?.action === 'coordinator.sendCoordinatorMessage').length, before)
})

for (const [name, options, code] of [['inherited review Profile', { unsafeProfile: true }, 'review_model_unbounded'],
  ['API key fallback', { paidFallback: true }, 'paid_fallback_enabled'],
  ['Environment harness mismatch', { badEnvironment: true }, 'environment_incompatible']]) {
  test(name + ' blocks before any paid submission without editing existing configuration', async () => {
    const f = fixture(options), report = await f.run()
    assert.ok(report.cases.every(row => row.failure.code === code), JSON.stringify(report))
    assert.equal(f.issues.length, 0); assert.equal(f.runs.length, 0)
    assert.ok(!f.calls.some(call => call.method === 'PATCH' || call.body?.action === 'coordinator.sendCoordinatorMessage'))
  })
}

test('one quota-blocked subscription does not prevent the other real path', async () => {
  const f = fixture({ quotaCase: 'claude' }), report = await f.run()
  assert.equal(report.cases[0].failure.code, 'source_unavailable')
  assert.equal(report.cases[1].status, 'execution_observed')
  assert.equal(f.runs.length, 1); assert.equal(f.runs[0].item.id, 'codex')
})

test('enabled quota fallback with unrelated owner keys cannot reroute fixed small subscription paths', async () => {
  const f = fixture({ paidFallback: true, keyCatalog: [apiKey()] }), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
  assert.equal(report.preflight.apiKeyFallbackDisabled, false)
  assert.equal(report.preflight.ownChatKeyFallbackReachable, false)
  assert.equal(f.runs.length, 2)
  assert.ok(!f.calls.some(call => /Fallback|ApiKey|chooseBotModel/i.test(call.body?.action ?? '')))
})

test('same-model owner chat keys block before payment while a custom Anthropic-only key has no chat fallback path', async () => {
  for (const item of CASES) {
    const f = fixture({ paidFallback: true, chatModel: item.id, keyCatalog: [apiKey([item.model], 'custom')] }), report = await f.run()
    assert.ok(report.cases.every(row => row.failure?.code === 'paid_fallback_enabled'), JSON.stringify(report))
    assert.equal(f.issues.length, 0); assert.equal(f.runs.length, 0)
  }
  const f = fixture({ paidFallback: true, keyCatalog: [apiKey([CASES[0].model], 'custom', 'anthropic')] }), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
})

test('fallback reachability follows the actual Coordinator model, never the other fixed producer model', async () => {
  const f = fixture({ paidFallback: true, chatModel: 'claude', keyCatalog: [apiKey([CASES[1].model], 'openai')] }), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
  assert.equal(report.preflight.selection.coordinatorModel, CASES[0].model)
  assert.equal(report.preflight.ownChatKeyFallbackReachable, false)
})

test('missing or unknown owner API key catalog fields are never treated as proof that fallback is absent', async () => {
  for (const keyCatalog of [{}, [{ id: id(44), models: [] }], [{ ...apiKey(), provider: 'unknown' }], [{ ...apiKey(), models: null }]]) {
    const f = fixture({ paidFallback: true, keyCatalog }), report = await f.run()
    assert.equal(report.failure?.code, 'response_invalid', JSON.stringify(report))
    assert.equal(report.failure?.detail, 'api_key_catalog')
    assert.equal(f.issues.length, 0); assert.equal(f.profiles.length, 0); assert.equal(f.runs.length, 0)
  }
})

test('a real dispatch quota refusal keeps its Task and code, then continues the other subscription', async () => {
  const f = fixture({ refuseCase: 'claude' }), report = await f.run()
  assert.equal(report.cases[0].failure.code, 'dispatch_refused')
  assert.equal(report.cases[0].failure.serverCode, 'subscriptionQuotaExhausted')
  assert.equal(report.cases[1].status, 'execution_observed')
  assert.equal(f.issues.length, 2)
  assert.equal(f.calls.filter(call => call.body?.action === 'coordinator.sendCoordinatorMessage').length, 2)
})

test('unexpected runtime provenance fails honestly and only closes its owned runs', async () => {
  const f = fixture({ wrongRunModel: true }), report = await f.run()
  assert.ok(report.cases.every(row => row.failure.code === 'run_model_mismatch'))
  assert.deepEqual(f.machineEnds, f.runs.map(row => row.id))
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
  assert.equal(f.issues.length, 2)
})

test('cleanup needs provider retirement acknowledgement and retains Profile for recovery on failure', async () => {
  const f = fixture({ failMachine: true }), report = await f.run()
  assert.ok(report.cases.every(row => row.cleanup.status === 'failed'))
  assert.ok(f.profiles.every(profile => !profile.archivedAt))
  assert.equal(report.status, 'partial_or_blocked')
})

test('an uncertain submitted turn reclaims known attempts but retains its fixed Profile and explicit recovery warning', async () => {
  const f = fixture({ uncertainDispatch: 'claude' }), report = await f.run()
  const failed = report.cases[0]
  assert.equal(failed.status, 'failed')
  assert.equal(failed.cleanup.status, 'failed')
  assert.ok(failed.cleanup.errors.some(error => error.code === 'dispatch_outcome_unknown'))
  assert.equal(failed.cleanup.machines.length, 0, 'Task ownership cannot reconstruct a missing dispatch receipt')
  assert.ok(!f.machineEnds.includes(f.runs[0].id))
  assert.equal(f.profiles[0].archivedAt, null)
  assert.equal(report.cases[1].status, 'execution_observed')
  assert.equal(f.issues.length, 2); assert.equal(f.runs.length, 2)
  assert.ok(!JSON.stringify(report).includes('PRIVATE_'))
})

test('an unrelated same-Task owned Run is neither adopted as evidence nor stopped during cleanup', async () => {
  const f = fixture({ foreignRun: true, foreignDispatchEvent: true }), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
  assert.deepEqual(new Set(f.machineEnds), new Set(f.runs.filter(run => !run.foreign).map(run => run.id)))
  assert.ok(!f.calls.some(call => ['agents.pollIssueThreads', 'agents.stopRun'].includes(call.body?.action)))
})

test('a same-Task dispatch without this submission reference remains unknown and cannot authorize cleanup', async () => {
  const f = fixture({ missingDispatchReference: true }), report = await f.run()
  assert.ok(report.cases.every(row => row.failure?.code === 'dispatch_missing' && row.cleanup.status === 'failed'), JSON.stringify(report))
  assert.equal(f.machineEnds.length, 0)
  assert.ok(f.profiles.every(profile => profile.archivedAt === null))
})

test('a complete matching requestKey also proves the dispatch when the independent quote is absent', async () => {
  const f = fixture({ requestKeyPreview: true }), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
  assert.equal(f.machineEnds.length, 2)
})

test('a dispatch preview with another Profile never becomes cleanup authority merely because the Task and owner match', async () => {
  const f = fixture({ foreignProducerProfile: true }), report = await f.run()
  assert.ok(report.cases.every(row => row.failure?.code === 'run_scope_mismatch' && row.cleanup.status === 'failed'), JSON.stringify(report))
  assert.equal(f.machineEnds.length, 0)
  assert.ok(!f.calls.some(call => call.body?.action === 'cancel'))
  assert.ok(f.profiles.every(profile => profile.archivedAt === null))
})

test('a foreign epoch prevents Factory cancellation and never expands exact-machine cleanup authority', async () => {
  const f = fixture({ foreignEpoch: true, wrongRunModel: true }), report = await f.run()
  assert.ok(report.cases.every(row => row.cleanup.errors.some(error => error.code === 'cleanup_scope_changed')), JSON.stringify(report))
  assert.ok(!f.calls.some(call => call.body?.action === 'cancel'))
  assert.deepEqual(new Set(f.machineEnds), new Set(f.runs.filter(run => !run.foreign).map(run => run.id)))
  assert.ok(f.profiles.every(profile => profile.archivedAt === null))
})

test('a changed Factory request epoch is incomplete cleanup and leaves all later user Runs untouched', async () => {
  const f = fixture({ changedEpoch: true }), report = await f.run()
  assert.ok(report.cases.every(row => row.cleanup.status === 'failed'), JSON.stringify(report))
  assert.ok(report.cases.every(row => row.cleanup.errors.some(error => error.code === 'cleanup_scope_changed')))
  assert.deepEqual(new Set(f.machineEnds), new Set(f.runs.filter(run => !run.foreign).map(run => run.id)))
})

test('lost Profile create responses recover by exact request ID and verified definition without a second create', async () => {
  const f = fixture({ loseProfileResponse: true }), report = await f.run()
  assert.equal(report.status, 'execution_observed_pending_snapshot_review', JSON.stringify(report))
  assert.equal(f.profiles.length, 2); assert.ok(f.profiles.every(profile => profile.archivedAt))
  assert.ok(report.cases.every(row => row.profileCreateRecovered === true && row.createdProfile.confirmed === true))
  assert.equal(f.calls.filter(call => call.path === '/api/factory/agent-profiles' && call.method === 'POST').length, 2)
})

test('an unknown Profile create receipt is retained as incomplete and sends no task or paid submission', async () => {
  const f = fixture({ loseProfileResponse: true, failProfileRecovery: true }), report = await f.run()
  assert.equal(report.status, 'partial_or_blocked')
  assert.equal(f.issues.length, 0); assert.equal(f.runs.length, 0)
  assert.ok(report.cases.every(row => row.cleanup.status === 'failed' && row.createdProfile.confirmed === false))
  assert.ok(f.profiles.every(profile => profile.archivedAt === null))
})

test('dispatch and execution share one case deadline, preserving exact cleanup time instead of doubling the work budget', async () => {
  const f = fixture({ dispatchAdvanceMs: 1200 }), report = await f.run()
  assert.ok(report.cases.every(row => row.failure?.code === 'work_deadline'), JSON.stringify(report))
  assert.ok(report.cases.every(row => row.cleanup.status === 'passed'))
  assert.deepEqual(new Set(f.machineEnds), new Set(f.runs.map(run => run.id)))
  assert.equal(report.cleanup.sessionClosed, true)
})

test('a moving application version cannot report a successful preflight', async () => {
  const f = fixture({ changedBuild: true }), report = await f.run({ mode: 'preflight', scope: null })
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'build_changed')
  assert.equal(report.cleanup.sessionClosed, true)
})

test('unknown errors and server data never become public report text', () => {
  const error = Object.assign(new Error('PRIVATE_SECRET'), { detail: 'PRIVATE_RESPONSE', serverCode: 'PRIVATE_VALUE' })
  assert.deepEqual(publicFailure(error), { code: 'observation_failed' })
})

test('existing workflow isolates the new manual job, uses only smoke OIDC credentials, and retains old gates', () => {
  const text = readFileSync(new URL('../../.github/workflows/production-smoke.yml', import.meta.url), 'utf8')
  const job = text.slice(text.indexOf('  domain-model:'), text.indexOf('  lease-audit:'))
  assert.match(job, /inputs\.domain_model_sha != ''/)
  assert.match(job, /production-smoke-owner-acceptance/)
  assert.match(job, /--check-target/)
  assert.match(job, /DOMAIN_OTHER_AUDIT_RECOVERY_RUN: \$\{\{ inputs\.audit_recover_lease_run \}\}/)
  assert.match(job, /secret-name: SMOKE_OWNER_EMAIL/)
  assert.match(job, /secret-name: SMOKE_OWNER_PASSWORD/)
  assert.equal((job.match(/method: oidc/g) ?? []).length, 2)
  assert.ok(!/secret-path: \/(?:vercel|platform|neon)|startup|deepseek|browser|runtime-refresh/i.test(job))
  assert.ok(text.indexOf('--check-target') < text.indexOf('secret-name: SMOKE_OWNER_EMAIL'))
  for (const name of ['lease-audit', 'auth-audit', 'smoke', 'deployment-comparison']) {
    const next = text.slice(text.indexOf('  ' + name + ':')).split('\n').find(line => line.startsWith('    if:'))
    assert.match(next, /inputs\.domain_model_sha == ''/)
    assert.match(next, /inputs\.domain_model_scope == ''/)
    assert.match(next, /inputs\.domain_model_mode == 'preflight'/)
  }
  assert.match(job, /inputs\.domain_model_scope != ''/)
  assert.match(job, /inputs\.domain_model_mode != 'preflight'/)
})
