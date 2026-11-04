import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import {
  AcceptanceError, CASES, MARKER, ORIGIN, REPOSITORY, actionResult, attestDeployment, buildTaskPrompt,
  decisionProof, discoverActions, publicFailure, readChatState, runProjectDecisionsAcceptance, smallArtifactBytes, successfulRelease, triggerGuard,
} from './project-decisions.mjs'

const SHA = 'a'.repeat(40)
const OWNER = 'synthetic-owner'
const id = n => '10000000-0000-4000-8000-' + n.toString(16).padStart(12, '0')
const WS = id(1), PROJECT = id(2), ISSUE = id(3), BOT = id(4), RUN = id(5)
const KEY = id(6), CLAUDE = id(7), CODEX = id(8), DIRECTION = id(9)
const EPOCH = Date.parse('2026-11-04T12:00:00Z')
const env = (mode = 'preflight') => ({
  GITHUB_REPOSITORY: REPOSITORY, GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_dispatch',
  GITHUB_SHA: SHA, MIKKA_EXPECTED_DEPLOYMENT_SHA: SHA, MIKKA_PROJECT_DECISIONS_MODE: mode,
  SMOKE_OWNER_EMAIL: 'test+mikka-smoke-project@example.invalid', SMOKE_OWNER_PASSWORD: 'private-password-sentinel',
})
const event = mode => ({ inputs: { mode: mode ?? 'preflight' } })
const attestation = (mode = 'preflight') => ({
  status: 'ready', issue: 1245, repository: REPOSITORY, revision: SHA, mode, workerReleaseSha: SHA,
  webDeployRunId: 11, workerReleaseRunId: 12, checkedAt: new Date(EPOCH).toISOString(),
})
const release = kind => ({
  id: kind === 'web' ? 11 : 12, name: kind === 'web' ? 'Web deploy' : 'E2B official instance runtime',
  path: kind === 'web' ? '.github/workflows/web-deploy.yml' : '.github/workflows/e2b-official-runtime.yml',
  head_sha: SHA, head_branch: 'main', head_repository: { full_name: REPOSITORY },
  event: 'push', status: 'completed', conclusion: 'success', head_commit: { message: 'Add project decisions ' + MARKER },
})

test('trigger gate binds manual main SHA and explicitly marked successful main Web deploy only', () => {
  assert.deepEqual(triggerGuard(env(), event()), { revision: SHA, mode: 'preflight' })
  const automatic = { ...env('active'), GITHUB_EVENT_NAME: 'workflow_run' }
  assert.equal(triggerGuard(automatic, { workflow_run: release('web') }).mode, 'active')
  for (const changed of [
    { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_REF: 'refs/pull/1/merge' }, { GITHUB_EVENT_NAME: 'pull_request' },
    { GITHUB_SHA: 'b'.repeat(40) }, { MIKKA_EXPECTED_DEPLOYMENT_SHA: 'main' }, { MIKKA_PROJECT_DECISIONS_MODE: 'all' },
  ]) assert.throws(() => triggerGuard({ ...env(), ...changed }, event()))
  for (const changed of [
    { head_sha: 'b'.repeat(40) }, { event: 'pull_request' }, { head_branch: 'feature' },
    { head_repository: { full_name: 'fork/Mikka' } }, { conclusion: 'failure' }, { status: 'in_progress' },
    { name: 'Other workflow' }, { head_commit: { message: 'ordinary change' } },
  ]) assert.throws(() => triggerGuard(automatic, { workflow_run: { ...release('web'), ...changed } }), /trigger_rejected/)
})

test('runtime release must be exact SHA/repository/workflow/main; legitimate manual releases are accepted', () => {
  assert.equal(successfulRelease([release('worker')], SHA, 'worker').id, 12)
  assert.equal(successfulRelease([{ ...release('worker'), event: 'workflow_dispatch' }], SHA, 'worker').id, 12)
  for (const changed of [
    { head_sha: 'b'.repeat(40) }, { id: 0 }, { event: 'pull_request' }, { head_branch: 'feature' },
    { path: '.github/workflows/e2b-byos.yml' }, { name: 'Unrelated' }, { conclusion: 'failure' },
    { head_repository: { full_name: 'fork/Mikka' } }, { status: 'in_progress' },
  ]) assert.equal(successfulRelease([{ ...release('worker'), ...changed }], SHA, 'worker'), null)
})

test('attestation never reads account credentials or forwards the GitHub token to production', async () => {
  const input = { ...env(), GH_TOKEN: 'private-github-token' }
  for (const key of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD']) Object.defineProperty(input, key, {
    get() { throw Error('credential was read before the workload gate') },
  })
  const calls = []
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url)
    calls.push(parsed.href)
    assert.equal(init.method, 'GET')
    assert.equal(init.redirect, 'error')
    if (parsed.origin === ORIGIN) {
      assert.equal(init.headers.authorization, undefined)
      return Response.json({ build: SHA })
    }
    assert.equal(parsed.origin, 'https://api.github.com')
    assert.equal(init.headers.authorization, 'Bearer private-github-token')
    assert.equal(parsed.searchParams.get('head_sha'), SHA)
    return Response.json({ workflow_runs: [release(parsed.pathname.includes('web-deploy') ? 'web' : 'worker')] })
  }
  assert.equal((await attestDeployment({ env: input, event: event(), fetchImpl, now: () => EPOCH })).status, 'ready')
  assert.ok(calls.length >= 5)
  await assert.rejects(attestDeployment({ env: input, event: event(), now: () => EPOCH,
    fetchImpl: async () => Response.json({ build: 'b'.repeat(40) }) }), /build_mismatch/)
  await assert.rejects(attestDeployment({ env: input, event: event(), now: () => EPOCH,
    fetchImpl: async url => new URL(url).origin === ORIGIN ? Response.json({ build: SHA }) : Response.json({ workflow_runs: [] }) }), /web_deploy/)
})

test('decision proof rejects forged identity, substituted models, reconstructed records and ungrounded changes', () => {
  const scope = { projectId: PROJECT, workspaceId: WS, issueId: ISSUE, botId: BOT, ownerId: OWNER, runId: RUN,
    model: 'claude-haiku-5-5', harness: 'claude_code', kind: 'redirect', selectedOptionId: 'revised', predecessorId: id(10), directionToken: DIRECTION }
  const record = {
    id: id(11), projectId: PROJECT, workspaceId: WS, issueId: ISSUE, ownerId: OWNER, runId: RUN, kind: 'redirect',
    recordedBy: { kind: 'agent', id: RUN, userId: OWNER, botId: BOT, runId: RUN, modelId: scope.model,
      harness: scope.harness, identityAssurance: 'run_token' },
    captureMode: 'live', provenance: 'recorded', recordStatus: 'active', title: 'private-title',
    reason: 'private-reason ' + DIRECTION, summary: 'private-summary', selectedOptionId: 'revised',
    predecessorDecisionIds: [id(10)], options: [
      { id: 'baseline', disposition: 'abandoned', reason: 'private-option-reason' }, { id: 'revised', disposition: 'selected' },
    ], sources: [{ sourceRef: id(12), role: 'evidence', locator: { type: 'run', id: RUN } }],
  }
  const proof = decisionProof(record, scope)
  for (const privateText of ['private-title', 'private-reason', 'private-summary', 'private-option-reason', DIRECTION])
    assert.ok(!JSON.stringify(proof).includes(privateText))
  for (const changed of [
    { ownerId: 'another-owner' }, { projectId: id(100) }, { runId: id(101) },
    { recordedBy: { ...record.recordedBy, kind: 'human' } }, { recordedBy: { ...record.recordedBy, id: id(102) } },
    { recordedBy: { ...record.recordedBy, modelId: 'other-model' } },
    { recordedBy: { ...record.recordedBy, identityAssurance: 'authenticated_user' } },
    { captureMode: 'human_marked' }, { captureMode: 'reconstructed', provenance: 'inferred' },
    { recordStatus: 'retracted' }, { sources: [] },
    { sources: [{ sourceRef: id(12), role: 'evidence', locator: { type: 'run', id: id(99) } }] },
    { predecessorDecisionIds: [] }, { selectedOptionId: 'baseline' }, { reason: 'no token', summary: 'no token' },
  ]) assert.throws(() => decisionProof({ ...record, ...changed }, scope))
  const bot = { ...record, runId: null, kind: 'confirm', recordedBy: { ...record.recordedBy, kind: 'bot', id: BOT, runId: null, identityAssurance: 'host_context' },
    sources: [{ sourceRef: id(12), role: 'evidence', locator: { type: 'issue', id: ISSUE } }] }
  assert.equal(decisionProof(bot, { ...scope, actor: 'bot', kind: 'confirm' }).actor, 'bot')
})

test('errors project provider 402 without raw error details', () => {
  assert.deepEqual(publicFailure(new AcceptanceError('provider_refused', 'blocked', {
    providerStatus: 402, providerKind: 'balance', password: 'private-password', serverCode: 'secret-body', raw: 'private-text',
  })), { status: 'blocked', code: 'provider_refused', providerStatus: 402, providerKind: 'balance' })
  assert.deepEqual(publicFailure(new Error('private-password')), { status: 'failed', code: 'acceptance_failed' })
})

const names = ['saveProject', 'listProjects', 'saveIssue', 'setProjectIssues', 'getIssueThread', 'changeModelOrder']
const refs = Object.fromEntries(names.map((name, i) => [name, String(i + 1).repeat(40)]))
const bundle = names.map(name => '(0,r.createServerReference)("' + refs[name] + '",r.callServer,void 0,r.findSourceMapURL,"' + name + '")').join(';')
const flight = result => new Response('0:{"a":"$@1"}\n1:' + JSON.stringify(result) + '\n')

test('only published allowlisted UI actions are discovered; Flight references are resolved', async () => {
  const paths = []
  const result = await discoverActions(async path => {
    paths.push(path)
    return new Response(path.includes('.js') ? bundle : '<script src="/mikka/_next/static/chunks/known.js"></script><script src="https://evil.invalid/secret.js"></script>')
  })
  assert.deepEqual(result, refs)
  assert.ok(paths.every(path => !path.includes('evil.invalid')))
  assert.deepEqual(actionResult('0:{"a":"$@1"}\n1:{"project":{"id":"ok"}}\n', 'saveProject'), { project: { id: 'ok' } })
  assert.throws(() => actionResult('0:{"a":{}}\n', 'deleteWorkspace'), /action_not_allowed/)
  assert.throws(() => actionResult('0:{"a":{"error":"secret-body"}}\n', 'saveProject'), /action_refused/)
})


test('Next-generated direct, member and long bracket references require five arguments', async () => {
  // Next 16.4.1 compiler output and the existing Turbopack public dev chunks.
  const namespace = '__TURBOPACK__imported__module__$5b$project$5d$' + 'module$'.repeat(40)
  const source = [
    'createServerReference("' + refs.saveProject + '",callServer,void 0,findSourceMapURL,"saveProject")',
    '(0,r.createServerReference)("' + refs.listProjects + '",r.callServer,void 0,r.findSourceMapURL,"listProjects")',
    '(0,' + namespace + '["createServerReference"])("' + refs.saveIssue + '",' + namespace + '["callServer"],void 0,' + namespace + '["findSourceMapURL"],"saveIssue")',
    "(0,r['createServerReference'])('" + refs.setProjectIssues + "',r['callServer'],undefined,r['findSourceMapURL'],'setProjectIssues')",
    'createServerReference (\n"' + refs.getIssueThread + '", callServer, undefined, findSourceMapURL,\n"getIssueThread"\n)',
    'r.createServerReference("' + refs.changeModelOrder + '",r.callServer,void 0,r.findSourceMapURL,"changeModelOrder")',
    '(0,r.createServerReference)("' + 'f'.repeat(40) + '",r.callServer,"getIssueThread")',
    'otherFactory("' + 'f'.repeat(40) + '",callServer,void 0,findSourceMapURL,"saveProject")',
    'createServerReference("' + 'f'.repeat(40) + '",callServer,void 0,findSourceMapURL,"getIssue")',
  ].join(';\n')
  const result = await discoverActions(async path => new Response(path.includes('.js') ? source
    : '<script src="/mikka/_next/static/chunks/generated.js"></script>'))
  assert.deepEqual(result, refs)
})

test('discovery visits real UI routes and bounded same-origin nested public chunks', async () => {
  const paths = [], diagnostics = {}
  const reference = name => 'createServerReference("' + refs[name] + '",callServer,void 0,findSourceMapURL,"' + name + '")'
  const pages = new Map([
    ['/en', '<script src="/mikka/_next/static/chunks/root.js"></script><script src="https://evil.invalid/secret.js"></script>'],
    ['/en?section=projects', '<script src="/mikka/_next/static/chunks/projects.js"></script>'],
    ['/en/settings?section=models', '<link href="/mikka/_next/static/chunks/settings.js" rel="modulepreload">'],
  ])
  const chunks = new Map([
    ['/mikka/_next/static/chunks/root.js', reference('listProjects') + ';' + reference('saveIssue') + ';"static/chunks/thread.js";"static/chunks/../secret.js";"https://evil.invalid/static/chunks/foreign.js"'],
    ['/mikka/_next/static/chunks/projects.js', reference('saveProject') + ';"static/chunks/project/detail.js?dpl=public-suffix"'],
    ['/mikka/_next/static/chunks/settings.js', reference('changeModelOrder')],
    ['/mikka/_next/static/chunks/thread.js', reference('getIssueThread')],
    ['/mikka/_next/static/chunks/project/detail.js?dpl=public-suffix', reference('setProjectIssues')],
  ])
  const result = await discoverActions(async path => {
    paths.push(path)
    const source = pages.get(path) ?? chunks.get(path)
    return new Response(source ?? '', { status: source === undefined ? 404 : 200 })
  }, diagnostics)
  assert.deepEqual(result, refs)
  assert.deepEqual(paths.filter(path => !path.includes('/_next/')), [...pages.keys()])
  assert.ok(paths.includes('/mikka/_next/static/chunks/project/detail.js?dpl=public-suffix'))
  assert.ok(!paths.some(path => /secret|foreign|evil|manifest/.test(path)))
  assert.deepEqual(diagnostics, { required: names, found: names, missing: [],
    pagesRead: 3, pagesFailed: 0, chunksRead: 5, chunksFailed: 0, chunksRemaining: 0 })
})

test('missing actions are reported as fixed names and counts before any case mutation', async () => {
  const f = fixture()
  const incomplete = names.filter(name => name !== 'getIssueThread')
    .map(name => '(0,r.createServerReference)("' + refs[name] + '",r.callServer,void 0,r.findSourceMapURL,"' + name + '")').join(';')
  const fetchImpl = async (input, init) => new URL(input).pathname.includes('/_next/')
    ? new Response(incomplete + '/* private-source-sentinel */') : f.fetchImpl(input, init)
  const report = await runProjectDecisionsAcceptance({ env: env(), event: event(), attestation: attestation(), fetchImpl, now: f.now, wait: f.wait })
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.actionDiscovery.missing, ['getIssueThread'])
  assert.deepEqual(report.actionDiscovery.found, names.filter(name => name !== 'getIssueThread'))
  assert.equal(report.actionDiscovery.chunksRead, 1)
  assert.ok(report.cases.every(item => item.status === 'blocked' && item.code === 'action_missing' && item.cleanup.state === 'not_created'))
  assert.ok(f.calls.filter(call => call.method !== 'GET').every(call => ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(call.path)))
  const serialized = JSON.stringify(report)
  for (const forbidden of ['private-source-sentinel', 'private-password-sentinel', 'private-cookie-sentinel', ...Object.values(refs)])
    assert.ok(!serialized.includes(forbidden))
})

test('discovery reports its remaining public chunks when the scan bound is reached', async () => {
  const diagnostics = {}
  const result = await discoverActions(async path => {
    if (!path.includes('/_next/')) return new Response('<script src="/mikka/_next/static/chunks/0.js"></script>')
    const index = Number(/\/(\d+)\.js$/.exec(path)?.[1])
    return new Response('"static/chunks/' + (index + 1) + '.js"')
  }, diagnostics)
  assert.deepEqual(result, {})
  assert.equal(diagnostics.chunksRead, 200)
  assert.equal(diagnostics.chunksRemaining, 1)
  assert.deepEqual(diagnostics.missing, names)
})

test('invalid attestation and foreign origins fail before reading or sending account values', async () => {
  const input = env()
  for (const name of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD']) Object.defineProperty(input, name, {
    get() { throw Error('private credential getter should not be reached') },
  })
  let calls = 0
  const fetchImpl = async () => { calls++; throw Error('unexpected') }
  await assert.rejects(runProjectDecisionsAcceptance({ env: input, event: event(), attestation: { ...attestation(), revision: 'b'.repeat(40) }, fetchImpl, now: () => EPOCH }), /attestation_required/)
  await assert.rejects(runProjectDecisionsAcceptance({ env: { ...env(), MIKKA_ACCEPTANCE_BASE_URL: 'https://evil.invalid/mikka' },
    event: event(), attestation: attestation(), fetchImpl, now: () => EPOCH }), /origin_rejected/)
  assert.equal(calls, 0)
})

test('task prompt uses the structured issue and leaves the future live direction unknown', () => {
  const prompt = buildTaskPrompt({ marker: 'fixture', projectId: PROJECT, workspaceId: WS, issueId: ISSUE, item: CASES[1], botRecord: true })
  assert.ok(prompt.includes('dispatch_bot_computer'))
  assert.ok(prompt.includes('existing issue ' + ISSUE))
  assert.ok(prompt.includes('Omit projectId, workspaceId and issueId'))
  assert.ok(!prompt.includes(DIRECTION))
  assert.ok(prompt.includes('Do not create a second issue or task'))
})

test('workflow attests before OIDC and uploads only two explicit sanitized reports', async () => {
  const workflow = await readFile(new URL('../../.github/workflows/project-decisions-acceptance.yml', import.meta.url), 'utf8')
  assert.ok(workflow.indexOf('project-decisions.mjs --attest') < workflow.indexOf('Infisical/secrets-action'))
  assert.ok(workflow.includes('contains(github.event.workflow_run.head_commit.message, \'[project-map-acceptance]\')'))
  assert.ok(workflow.includes('ref: ' + '$' + '{{ github.event.workflow_run.head_sha || github.sha }}'))
  assert.ok(workflow.includes('secret-path: /'))
  assert.ok(workflow.includes('recursive: false'))
  assert.ok(workflow.includes('project-decisions-report/attestation.json'))
  assert.ok(workflow.includes('project-decisions-report/report.json'))
  assert.ok(!workflow.includes('path: .cache'))
})

function fixture({ active = false, noWorking = false, providerFailureAtChat = false } = {}) {
  let tick = EPOCH, counter = 100, orderCounter = 500
  const ids = () => id(counter++)
  const sources = CASES.map((item, index) => ({
    id: id(20 + index), model: item.model, harness: item.harness, credentialOwnerId: OWNER,
    source: item.kind === 'api_key' ? { kind: 'api_key', keyId: KEY } : { kind: 'subscription', connectionId: item.provider === 'claude' ? CLAUDE : CODEX },
  }))
  let entries = sources.map(value => ({ ...value }))
  const projects = [], issues = [], bots = [], calls = [], sequence = []
  const order = () => ({ location: 'cloud', cloudReady: true, customized: true, entries: entries.map(entry => ({
    ...entry, ...(entry.model === 'deepseek-flash' && !providerFailureAtChat ? { block: { reason: 'balance' } } : {}),
  })), candidates: sources, cloudModels: Object.fromEntries(entries.map(entry => [entry.id, 'ready'])) })
  const menu = bot => ({
    groups: [
      { kind: 'apiKey', options: [{ id: 'apikey:' + KEY + ':deepseek-flash', modelId: 'deepseek-flash', provider: 'deepseek' }] },
      { kind: 'subscription', options: [
        { id: CLAUDE, modelId: 'claude-haiku-5-5', provider: 'claude' },
        { id: CODEX, modelId: 'gpt-6-luna', provider: 'codex' },
      ] },
    ], current: bot?.chosen ? { modelId: bot.item.model, kind: bot.item.kind === 'api_key' ? 'apiKey' : 'subscription', available: true } : null,
  })
  const botForRun = runId => bots.find(bot => [bot.runId, bot.reviewId, bot.verifyId].includes(runId))
  const task = bot => ({
    task: { id: bot.taskId, issueId: bot.issueId, userId: OWNER, botId: bot.id, revision: 1, sourceEventId: id(90),
      status: bot.cancelled ? 'cancelled' : bot.steered ? 'completed' : 'running', candidateId: bot.steered ? bot.candidateId : null },
    attempts: [
      { stage: 'execute', runId: bot.runId, status: bot.steered ? 'passed' : 'running' },
      ...(bot.steered ? ['review', 'verify'].map(stage => ({ stage, runId: bot[stage + 'Id'], status: 'passed',
        candidateId: bot.candidateId, output: { requestEpoch: id(90) } })) : []),
    ], candidates: bot.steered ? [{ id: bot.candidateId, runId: bot.runId }] : [],
  })
  const evidence = (bot, runId) => {
    const resourceId = bot.item.provider === 'claude' ? CLAUDE : CODEX
    return { run: {
      id: runId, botId: bot.id, issueId: bot.issueId, status: bot.steered ? 'succeeded' : bot.stopped ? 'stopped' : 'running',
      model: bot.item.model, harness: bot.item.harness, credentialType: 'subscription',
      subscriptionRoute: bot.item.harness === 'codex' ? 'codex_cli' : 'claude_code_cli',
      executionIdentity: { version: 1, requester: OWNER, executionPrincipal: OWNER, outputOwner: OWNER, botId: bot.id,
        botOwner: OWNER, workspaceId: WS, personalResourcePolicy: 'requester_only',
        billingAccount: { model: { kind: 'subscription', ownerId: OWNER, resourceId }, runtime: { kind: 'e2b', ownerId: OWNER } },
        resourceBindings: [{ kind: 'subscription', id: resourceId, ownerId: OWNER, access: 'owner' }] },
    }, artifacts: bot.steered ? [{ id: bot.artifactId, title: bot.name + '.md', latestVersion: 1,
      url: '/mikka/api/artifacts/' + bot.artifactId + '/versions/1/download' }] : [] }
  }
  const records = bot => {
    if (!bot?.sent || (providerFailureAtChat && bot.item.kind === 'api_key')) return []
    const base = { projectId: bot.projectId, workspaceId: WS, issueId: bot.issueId, ownerId: OWNER,
      captureMode: 'live', provenance: 'recorded', recordStatus: 'active', reason: 'private-reason', summary: 'private-summary',
      runId: bot.runId, recordedBy: { kind: 'agent', id: bot.runId, userId: OWNER, botId: bot.id, runId: bot.runId,
        modelId: bot.item.model, harness: bot.item.harness, identityAssurance: 'run_token' },
      sources: [{ sourceRef: bot.sourceRef, role: 'evidence', locator: { type: 'run', id: bot.runId } }] }
    return [
      { ...base, id: bot.chooseId, kind: 'choose', title: bot.name + ' choose', selectedOptionId: 'baseline',
        options: [{ id: 'baseline', disposition: 'selected' }, { id: 'alternative', disposition: 'rejected', reason: 'private-option' }] },
      ...(bot.botRecord ? [{ ...base, id: bot.botDecisionId, kind: 'confirm', title: bot.name + ' bot', runId: null,
        recordedBy: { ...base.recordedBy, kind: 'bot', id: bot.id, runId: null, identityAssurance: 'host_context' },
        sources: [{ sourceRef: bot.sourceRef, role: 'evidence', locator: { type: 'issue', id: bot.issueId } }] }] : []),
      ...(bot.steered ? [{ ...base, id: bot.redirectId, kind: 'redirect', title: bot.name + ' redirect',
        selectedOptionId: 'revised', reason: 'private-direction ' + bot.token, predecessorDecisionIds: [bot.chooseId],
        options: [{ id: 'baseline', disposition: 'abandoned', reason: 'private-option' }, { id: 'revised', disposition: 'selected' }] }] : []),
    ]
  }
  async function fetchImpl(input, init) {
    const url = new URL(input), path = url.pathname.replace(/^\/mikka/, ''), method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path, method })
    assert.equal(url.origin, ORIGIN)
    assert.equal(init.redirect, 'error')
    assert.equal(init.headers.authorization, undefined)
    if (path === '/api/version') return Response.json({ build: SHA })
    if (path === '/api/auth/sign-in/email') return Response.json({}, { headers: { 'set-cookie': 'session=private-cookie-sentinel; HttpOnly' } })
    assert.equal(init.headers.cookie, 'session=private-cookie-sentinel')
    if (path === '/api/auth/get-session') return Response.json({ user: { id: OWNER, email: env().SMOKE_OWNER_EMAIL } })
    if (path === '/api/auth/sign-out') return Response.json({ success: true })
    if (path.startsWith('/_next/')) return new Response(bundle)
    if ((path === '/en' || path === '/en/settings') && method === 'GET') return new Response('<script src="/mikka/_next/static/chunks/known.js"></script>')
    if (path === '/en' && method === 'POST') {
      const name = names.find(name => refs[name] === init.headers['next-action'])
      assert.ok(active || ['listProjects', 'getIssueThread'].includes(name), 'preflight must not mutate')
      const value = body[0]
      if (name === 'listProjects') return flight(projects)
      if (name === 'saveProject') {
        const project = { ...value, id: ids(), userId: OWNER, issueIds: [], revision: 1 }; projects.push(project); return flight({ project })
      }
      if (name === 'saveIssue') {
        const issue = { ...value, id: ids(), userId: OWNER, scope: 'personal', linearTargetVerified: false, revision: 1 }
        issues.push(issue); return flight({ issue })
      }
      if (name === 'setProjectIssues') {
        const project = projects.find(project => project.id === value.id)
        Object.assign(project, { issueIds: value.issueIds, revision: 2 }); return flight({ project })
      }
      if (name === 'getIssueThread') return flight({ thread: { rootRunId: body[1], modelFallback: [] }, chunks: [] })
      if (name === 'changeModelOrder') {
        if (value.kind === 'remove') entries = entries.filter(entry => entry.id !== value.id)
        if (value.kind === 'add') entries.push(...value.entries.map(entry => ({ ...entry, id: id(orderCounter++), credentialOwnerId: OWNER })))
        if (value.kind === 'reorder') entries = value.ids.map(key => entries.find(entry => entry.id === key))
        return flight(order())
      }
    }
    if (path === '/api/settings/model-order') return Response.json(order())
    if (path === '/api/settings/api-keys') return Response.json({ keys: [{ id: KEY, provider: 'deepseek' }] })
    if (path === '/api/subscriptions') return Response.json({ connections: [
      { id: CLAUDE, provider: 'claude', state: 'connected', paused: false },
      { id: CODEX, provider: 'codex', state: 'connected', paused: false },
    ] })
    if (path === '/api/mobile/threads') return Response.json({ threads: [] })
    if (path === '/api/settings/workspace-bots') return Response.json({ bots: [{ status: 'idle', runningThreads: 0 }] })
    if (path === '/api/bots' && method === 'GET') return Response.json([{ id: BOT, name: 'Smoke Bot', ownerId: OWNER, workspaceId: WS }, ...bots])
    if (path === '/api/bots' && method === 'POST') {
      const item = CASES.find(item => body.name.endsWith(item.id)), issue = issues.at(-1), project = projects.at(-1)
      const bot = { ...body, id: ids(), ownerId: OWNER, workspaceId: WS, item, issueId: issue.id, projectId: project.id,
        taskId: ids(), runId: ids(), reviewId: ids(), verifyId: ids(), candidateId: ids(), artifactId: ids(),
        chooseId: ids(), redirectId: ids(), sourceRef: ids(), botDecisionId: ids() }
      bots.push(bot); return Response.json(bot)
    }
    if (path === '/api/mobile/model') {
      const bot = bots.find(bot => bot.id === (body?.bot ?? url.searchParams.get('bot')))
      if (method === 'PUT') bot.chosen = true
      return Response.json(menu(bot))
    }
    if (path === '/api/mobile/chat/stop') return Response.json({ stopped: true })
    if (path === '/api/mobile/chat' && method === 'GET') {
      const bot = bots.find(bot => bot.id === url.searchParams.get('bot'))
      const failed = providerFailureAtChat && bot?.sent && bot.item.kind === 'api_key'
      // stopChatTurn leaves a failed turn's lastError in the normal ChatView.
      return Response.json({ botId: bot?.id, enabled: true, working: false, error: failed ? 'private-provider-error-sentinel' : null,
        failure: failed ? { kind: 'failed' } : null, items: failed ? [{ from: 'person', text: 'private-user-message-sentinel' }] : [],
        sources: {}, artifacts: {}, reactions: {} })
    }
    if (path === '/api/mobile/chat' && method === 'POST') {
      const bot = bots.find(bot => bot.id === body.botId)
      bot.sent = true; bot.botRecord = body.text.includes('"title":"' + bot.name + ' bot"')
      sequence.push('sent:' + bot.item.id)
      return Response.json({ queued: true }, { status: 202 })
    }
    if (path === '/api/factory/tasks') {
      const bot = bots.find(bot => bot.issueId === url.searchParams.get('issueId'))
      return Response.json({ issueId: url.searchParams.get('issueId'), tasks: bot?.sent && !(providerFailureAtChat && bot.item.kind === 'api_key') ? [{ id: bot.taskId }] : [] })
    }
    if (/^\/api\/factory\/tasks\/[^/]+$/.test(path)) {
      const bot = bots.find(bot => bot.taskId === path.split('/').at(-1))
      if (method === 'POST') bot.cancelled = true
      return Response.json(task(bot))
    }
    if (path.startsWith('/api/projects/')) {
      const projectId = path.split('/')[3], bot = bots.find(bot => bot.projectId === projectId)
      return Response.json({ projectId, workspaceId: WS, decisions: records(bot) })
    }
    if (/^\/api\/runs\/[^/]+\/evidence$/.test(path)) {
      const runId = path.split('/')[3], bot = botForRun(runId)
      return Response.json(evidence(bot, runId))
    }
    if (path.startsWith('/api/mobile/bots/')) {
      const bot = bots.find(bot => bot.id === path.split('/').at(-1))
      return Response.json({ threads: bot.sent && !(providerFailureAtChat && bot.item.kind === 'api_key') ? [{ id: bot.runId }] : [] })
    }
    if (/^\/api\/mobile\/threads\/[^/]+\/stop$/.test(path)) {
      botForRun(path.split('/')[4]).stopped = true
      return Response.json({ stopped: true })
    }
    if (/^\/api\/mobile\/threads\/[^/]+$/.test(path)) {
      const bot = botForRun(path.split('/')[4])
      if (method === 'GET') {
        sequence.push('working:' + bot.item.id)
        return Response.json({ working: !(noWorking && bot.item.id === 'official_claude') && !bot.steered && !bot.stopped })
      }
      assert.ok(sequence.includes('working:' + bot.item.id), 'steering requires a prior working observation')
      bot.token = /Direction token ([a-f0-9-]{36})/.exec(body.text)?.[1]
      assert.ok(bot.token)
      bot.steered = true; sequence.push('steered:' + bot.item.id)
      return Response.json({ queued: true }, { status: 202 })
    }
    if (path.startsWith('/api/artifacts/')) {
      const bot = bots.find(bot => bot.artifactId === path.split('/')[3])
      return new Response('project-decisions:' + bot.name + '\nroute=revised\n' + bot.token + '\n')
    }
    throw Error('unexpected synthetic request')
  }
  return { calls, sequence, projects, bots, fetchImpl, now: () => tick, wait: async ms => { tick += ms } }
}

test('DeepSeek balance blocker is independent; preflight checks both subscriptions and signs out', async () => {
  const f = fixture()
  const report = await runProjectDecisionsAcceptance({ env: env(), event: event(), attestation: attestation(), ...f })
  assert.deepEqual(report.cases.map(item => item.status), ['blocked', 'ready', 'ready'])
  assert.equal(report.cases[0].code, 'source_blocked')
  assert.equal(report.cases[0].block, 'balance')
  assert.equal(report.status, 'partial')
  assert.equal(report.sessionClosed, true)
  assert.equal(f.projects.length, 0)
  assert.ok(f.calls.every(call => call.method === 'GET' || ['/api/auth/sign-in/email', '/api/auth/sign-out'].includes(call.path)))
  for (const secret of ['private-password-sentinel', 'private-cookie-sentinel', env().SMOKE_OWNER_EMAIL])
    assert.ok(!JSON.stringify(report).includes(secret))
})

test('active subscriptions need working-time steering, same-run decisions, one Bot record and verified artifacts', async () => {
  const f = fixture({ active: true })
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, newId: () => DIRECTION })
  assert.deepEqual(report.cases.map(item => [item.status, item.code]), [['blocked', 'source_blocked'], ['pass', undefined], ['pass', undefined]])
  assert.equal(report.status, 'partial', 'blocked DeepSeek is never called a pass')
  assert.equal(report.botRecord.actor, 'bot')
  assert.equal(f.bots.filter(bot => bot.botRecord).length, 1)
  for (const result of report.cases.slice(1)) {
    assert.equal(result.midRun.observedWorking, true)
    assert.deepEqual(result.decisions.map(decision => decision.kind), ['choose', 'redirect'])
    assert.equal(result.decisions[1].source.id, result.runId)
    assert.equal(result.checks.length, 2)
    assert.equal(result.cleanup.state, 'stopped_evidence_retained')
    assert.equal(result.cleanup.orderRestored, true)
  }
  for (const text of ['private-reason', 'private-summary', 'private-option', 'private-direction', DIRECTION, env().SMOKE_OWNER_PASSWORD])
    assert.ok(!JSON.stringify(report).includes(text))
  assert.equal(report.sessionClosed, true)
})



test('chat reader accepts only its normal route and shape while preserving live control state', async () => {
  const view = { items: [{ text: 'private-chat-body' }], working: false, error: 'private-chat-error', failure: { kind: 'failed' },
    streamRunId: 'wrun_live_workflow' }
  const request = async path => {
    assert.equal(path, '/api/mobile/chat?bot=' + BOT)
    return Response.json(view)
  }
  assert.deepEqual(await readChatState(request, BOT), { working: false, streamRunId: 'wrun_live_workflow', failed: true })
  assert.deepEqual(await readChatState(async () => Response.json({ ...view, working: true, failure: null }), BOT),
    { working: true, streamRunId: 'wrun_live_workflow', failed: false })
  await assert.rejects(readChatState(async () => { throw Error('must not request another path') }, '../other'), /bot_scope/)
  for (const status of [401, 403, 500])
    await assert.rejects(readChatState(async () => Response.json(view, { status }), BOT),
      error => error.message === 'http_refused' && publicFailure(error).httpStatus === status)
  for (const value of [{ error: 'private-envelope' }, { ...view, items: null }, { ...view, working: 'false' },
    { ...view, error: {} }, { ...view, streamRunId: 123 }, { ...view, failure: { kind: 'unexpected' } }])
    await assert.rejects(readChatState(async () => Response.json(value), BOT), /response_invalid/)
  for (const failure of [{ kind: 'hosted', code: 'points_exhausted' }, { kind: 'subscription', notice: 'quota' },
    { kind: 'wake', code: 'wake_exhausted' }, { kind: 'failed' }])
    assert.equal((await readChatState(async () => Response.json({ ...view, failure }), BOT)).failed, true)
})


test('historical provider errors in a normal ChatView do not block cleanup or later subscriptions', async () => {
  const f = fixture({ active: true, providerFailureAtChat: true })
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, newId: () => DIRECTION })
  assert.deepEqual(report.cases.map(item => [item.status, item.code]), [['blocked', 'provider_refused'], ['pass', undefined], ['pass', undefined]])
  assert.equal(report.cases[0].providerStatus, undefined, 'a chat failure cannot prove an upstream HTTP status')
  assert.equal(report.cases[0].cleanup.state, 'stopped_evidence_retained')
  assert.equal(report.cases[0].cleanup.orderRestored, true)
  assert.equal(report.cases[0].cleanup.failure, undefined)
  assert.deepEqual(f.sequence.filter(item => item.startsWith('sent:')), ['sent:api_deepseek', 'sent:official_claude', 'sent:official_codex'])
  assert.equal(report.sessionClosed, true)
  for (const forbidden of ['private-provider-error-sentinel', 'private-user-message-sentinel'])
    assert.ok(!JSON.stringify(report).includes(forbidden))
})

test('an ended thread cannot pass as mid-run steering and does not stop the other subscription', async () => {
  const f = fixture({ active: true, noWorking: true })
  const report = await runProjectDecisionsAcceptance({ env: env('active'), event: event('active'), attestation: attestation('active'),
    ...f, newId: () => DIRECTION })
  assert.equal(report.cases[1].code, 'mid_run_window_missed')
  assert.equal(report.cases[1].status, 'blocked')
  assert.ok(!f.sequence.includes('steered:official_claude'))
  assert.equal(report.cases[2].status, 'pass')
})

test('artifact download enforces a small byte bound before retaining arbitrary model output', async () => {
  assert.equal((await smallArtifactBytes(new Response('ok'))).toString(), 'ok')
  await assert.rejects(smallArtifactBytes(new Response('x'.repeat(4097))), /artifact_content/)
})
