import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { BINDING, assertSetupRequest, capture, checkBinding, createSetupBudget, createSetupClient, executeSetup,
  guardContext, guardMain, newState, profileDefinition, profileDigest, publicFailure, validatePreflight,
  verifyPreflightSource, windowRecord } from './publication-setup-1782.mjs'

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0')
const hash = value => createHash('sha256').update(value).digest('hex')
const reader = 'synthetic-smoke-reader', admin = 'synthetic-policy-admin', adminName = 'Synthetic Admin'
const api = 'https://api.github.com/repos/alexj11324/Mikka'
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_EVENT_NAME: 'push',
  GITHUB_REF: 'refs/heads/ops/self-hosted-vault-closeout-20261108', GITHUB_ACTOR: 'alexj11324', GITHUB_TRIGGERING_ACTOR: 'alexj11324',
  GITHUB_SHA: 'b'.repeat(40), GITHUB_RUN_ID: '5678', GITHUB_RUN_ATTEMPT: '1', GITHUB_JOB: 'publication_setup',
  GITHUB_WORKFLOW_REF: 'alexj11324/Mikka/.github/workflows/issue1782-publication-setup.yml@refs/heads/ops/self-hosted-vault-closeout-20261108',
  GITHUB_TOKEN: 'synthetic-github-token', SMOKE_OWNER_EMAIL: 'reader+mikka-smoke@example.invalid', SMOKE_OWNER_PASSWORD: 'synthetic-password-do-not-emit' }
const event = { repository: { id: 1427517699, owner: { id: 183887963 } }, ref: env.GITHUB_REF,
  before: 'd'.repeat(40), after: env.GITHUB_SHA, forced: false, deleted: false }
const request = (action, args) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-mikka-workspace-id': id(90) },
  body: JSON.stringify({ version: 1, action, args }) })
const rpcResult = result => Response.json({ ok: true, result })
const copy = value => structuredClone(value)
const pinOf = ({ id, version, digest }) => ({ id, version, digest })

function fixture(change = () => {}) {
  const at = Date.now(), source = 'synthetic-immutable-preflight-source'
  const b = { applicationSha: 'a'.repeat(40), opsParentSha: 'd'.repeat(40), workspaceId: id(90), readerSha256: hash(reader),
    policyAdminSha256: hash(admin), policyAdminNameSha256: hash(adminName), subscriptionConnectionId: id(92), prechooseChoiceId: id(94),
    preflightRunId: 1234, preflightOpsSource: 'c'.repeat(40), preflightStatus: 'preflight_blocked', preflightArtifactId: 2345,
    preflightArtifactSha256: 'e'.repeat(64), preflightEvidenceSha256: 'f'.repeat(64), preflightSourceSha256: hash(source),
    botName: '1782-Pre-migration publication', profileDecision: { mode: 'create', requestId: id(93), name: '1782-Fixed producer' },
    enabledProfilePins: [], windowCommentId: 3456, windowCommentBodySha256: '1'.repeat(64),
    windowStartsAt: new Date(at - 1000).toISOString(), windowExpiresAt: new Date(at + 10 * 60000).toISOString() }
  const d = { source, session: { user: { id: reader, email: env.SMOKE_OWNER_EMAIL } },
    workspace: { currentUserId: reader, workspace: { id: id(90), kind: 'team' }, role: 'member', choices: [{ id: id(90), kind: 'team' }],
      members: [{ userId: reader, name: 'Synthetic Reader', role: 'member', status: 'active' }, { userId: admin, name: adminName, role: 'admin', status: 'active' }] },
    order: { location: 'cloud', cloudReady: true, candidates: [{ harness: 'claude_code', model: 'claude-haiku-5-5',
      source: { kind: 'subscription', connectionId: id(92) }, credentialOwnerId: admin }] },
    bots: [], profiles: [], createdId: id(91), selected: false, selectedId: id(94),
    keys: { apiKeyAfterQuota: false, keys: [] }, threads: [{ id: id(99), status: 'succeeded', prompt: 'synthetic-private-prompt' }],
    counts: { createBot: 0, choose: 0, createProfile: 0, archive: 0, signout: 0, pins: 0, clear: 0 },
    main: { ref: 'refs/heads/main', object: { type: 'commit', sha: b.applicationSha } },
    version: { build: b.applicationSha }, runtime: { total_count: 0, workflow_runs: [] },
    run: { id: b.preflightRunId, run_attempt: 1, head_sha: b.preflightOpsSource, head_branch: 'ops/self-hosted-vault-closeout-20261108',
      event: 'push', path: '.github/workflows/issue1782-publication-preflight.yml', status: 'completed', conclusion: 'failure',
      repository: { id: 1427517699, full_name: 'alexj11324/Mikka' }, actor: { login: 'alexj11324', id: 183887963 } },
    artifact: { id: b.preflightArtifactId, name: `publication-preflight-1782-${b.preflightRunId}-1`, expired: false,
      size_in_bytes: 2000, digest: 'sha256:' + b.preflightArtifactSha256, workflow_run: { id: b.preflightRunId, head_sha: b.preflightOpsSource } },
  }
  const profile = () => ({ ...profileDefinition(b), id: b.profileDecision.requestId ?? b.profileDecision.id, version: 1,
    digest: profileDigest(profileDefinition(b)), archivedAt: null, createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() })
  const menu = () => ({ groups: [{ kind: 'subscription', provider: 'claude', owner: adminName,
    options: [{ id: d.selected ? d.selectedId : b.prechooseChoiceId, modelId: 'claude-haiku-5-5', provider: 'claude' }] }],
    current: d.selected ? { id: d.selectedId, kind: 'subscription', provider: 'claude', modelId: 'claude-haiku-5-5',
      chosen: true, fallback: null, available: true } : null })
  change(d, b, { profile, menu })
  const choice = { status: 'correlated_unique_directories', orderObservation: { connectionId: b.subscriptionConnectionId,
    credentialOwnerSha256: b.policyAdminSha256 }, menuObservation: { choiceId: b.prechooseChoiceId, sharedOwnerNameSha256: b.policyAdminNameSha256 } }
  const p = { version: 1, batch: 1782, issue: 1687, mode: 'read_only_publication_preflight', status: b.preflightStatus, phase: 'complete',
    runAttempt: 1, runId: String(b.preflightRunId), opsSource: b.preflightOpsSource, mainSha: b.applicationSha, workspaceId: b.workspaceId,
    readerSha256: b.readerSha256, policyAdminSha256: b.policyAdminSha256, sourceSha256: b.preflightSourceSha256,
    cleanup: { signedOut: true }, executionBudget: { timersClosed: true }, inventory: { claudeChatChoice: choice,
      apiKeyFallbackReachable: false, automaticReviewSourcesBounded: true, configurationReady: false,
      profiles: b.enabledProfilePins.map(row => ({ ...row, enabled: true })),
      blockers: ['owned_idle_official_bot_missing', ...(b.profileDecision.mode === 'create' ? ['writable_profile_requires_review_or_creation'] : [])] } }
  let evidence
  const freezeEvidence = () => {
    const bytes = Buffer.from(JSON.stringify(p)); b.preflightEvidenceSha256 = hash(bytes)
    evidence = { bytes, receipt: { evidenceSha256: hash(bytes), opsSource: p.opsSource, runId: p.runId, runAttempt: 1,
      status: p.status, mainSha: p.mainSha, cleanup: { signedOut: true } } }
    return evidence
  }
  freezeEvidence()
  const comment = { id: b.windowCommentId, issue_url: api + '/issues/1752', user: { login: 'alexj11324', id: 183887963 },
    body: '<!-- mikka-1782-publication-setup:v1\n' + JSON.stringify(windowRecord(b)) + '\n-->' }
  b.windowCommentBodySha256 = hash(comment.body)
  const calls = []
  async function server(url, init) {
    const u = new URL(url), method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : undefined
    calls.push({ path: u.pathname, method, action: body?.action, args: body?.args, body, signal: init.signal })
    assert.equal(init.redirect, 'error'); assert.equal(init.signal instanceof AbortSignal, true)
    if (u.origin === 'https://api.github.com') {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + env.GITHUB_TOKEN)
      if (u.pathname.endsWith('/git/ref/heads/main')) return Response.json(d.main)
      if (u.pathname.endsWith('/issues/1752')) return Response.json({ number: 1752, comments: 5 })
      if (u.pathname.endsWith('/issues/1752/comments')) return Response.json([comment])
      if (u.pathname.endsWith('/e2b-official-runtime.yml/runs')) return Response.json(d.runtime)
      if (u.pathname.endsWith('/actions/runs/' + b.preflightRunId)) return Response.json(d.run)
      if (u.pathname.endsWith('/actions/artifacts/' + b.preflightArtifactId)) return Response.json(d.artifact)
      if (u.pathname.endsWith('/contents/scripts/ops/publication-preflight-1782.mjs')) return Response.json({ type: 'file', encoding: 'base64', content: Buffer.from(d.source).toString('base64') })
      assert.fail('unexpected source request')
    }
    assert.equal(u.origin, 'https://app.aspectlylabs.com'); assert.equal(new Headers(init.headers).has('authorization'), false)
    if (u.pathname === '/mikka/api/version') return Response.json(d.version)
    assert.equal(new Headers(init.headers).get('x-mikka-workspace-id'), b.workspaceId)
    assert.equal(new Headers(init.headers).get('origin'), u.origin)
    if (u.pathname === '/mikka/api/auth/sign-in/email') {
      assert.deepEqual(body, { email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD, rememberMe: false })
      return Response.json({ ok: true }, { headers: { 'set-cookie': 'session=synthetic; Path=/; HttpOnly' } })
    }
    assert.equal(new Headers(init.headers).get('cookie'), 'session=synthetic')
    if (u.pathname === '/mikka/api/auth/sign-out') { d.counts.signout++; return Response.json({}, { status: d.failSignout ? 500 : 200 }) }
    if (u.pathname === '/mikka/api/auth/get-session') return Response.json(d.session)
    if (u.pathname === '/mikka/api/workspace') return Response.json(d.workspace)
    if (u.pathname === '/mikka/api/settings/api-keys') return Response.json(d.keys)
    if (u.pathname === '/mikka/api/bots/' + d.createdId) return Response.json(d.botGet ?? d.bots.find(row => row.id === d.createdId))
    if (u.pathname === '/mikka/api/factory/agent-profiles' && method === 'GET') {
      const profiles = d.profiles.filter(row => !row.archivedAt)
      return Response.json({ profiles, availability: Object.fromEntries(profiles.map(row => [row.id, { available: !d.unavailableProfile }])),
        catalog: { models: [{ harness: 'claude_code', model: 'claude-haiku-5-5', source: { kind: 'subscription', connectionId: b.subscriptionConnectionId }, available: true }] } })
    }
    if (u.pathname === '/mikka/api/factory/agent-profiles' && method === 'POST') {
      d.counts.createProfile++; d.profiles.push(profile())
      if (d.unknownProfile) throw new Error('synthetic reply lost after actual mutation')
      return Response.json({ profile: d.badCreatedProfile ? { ...d.profiles.at(-1), digest: '0'.repeat(64) } : d.profiles.at(-1) }, { status: 201 })
    }
    if (u.pathname.startsWith('/mikka/api/factory/agent-profiles/')) {
      const i = u.pathname.split('/').at(-1), row = d.profiles.find(row => row.id === i); assert.ok(row)
      if (method === 'DELETE') {
        d.counts.archive++; assert.deepEqual(body, { workspaceId: b.workspaceId, version: 1 })
        if (d.failArchive) return Response.json({ error: 'synthetic_refused' }, { status: 409 })
        row.enabled = false; row.version++; row.archivedAt = new Date().toISOString()
        const { id: _id, version: _v, digest: _dg, archivedAt: _a, createdAt: _c, updatedAt: _u, ...definition } = row
        row.digest = profileDigest(definition)
      }
      if (d.badReadbackOnce) { d.badReadbackOnce = false; return Response.json({ profile: { ...row, version: 2 } }) }
      return Response.json({ profile: row })
    }
    assert.equal(u.pathname, '/mikka/api/rpc'); assert.equal(new Headers(init.headers).get('x-mikka-rpc'), '1')
    if (body.action === 'bots.pollBots') return rpcResult({ live: { ownerId: reader, workspaceId: b.workspaceId }, items: d.bots })
    if (body.action === 'model-order.getModelOrder') return rpcResult(d.order)
    if (body.action === 'task-runs.pollThreads') return rpcResult({ items: d.threads })
    if (body.action === 'execution-settings.getBotModelMenu') return rpcResult(d.menuOverride ?? menu())
    if (body.action === 'coordinator.pollCoordinatorChat') return rpcResult({ botId: body.args[0], working: Boolean(d.busy), enabled: d.selected,
      streamRunId: null, items: [{ text: 'synthetic-private-message-never-emit' }] })
    if (body.action === 'bots.createBot') {
      d.counts.createBot++; const bot = { id: d.createdId, name: b.botName, color: 'gris', shape: 'cercle', coordinator: false }; d.bots.push(bot)
      if (d.duplicateCreated) d.bots.push({ ...bot, id: id(192) })
      if (d.unknownBot) throw new Error('synthetic reply lost after own Bot committed')
      return rpcResult(d.badCreateAck ? { ...bot, color: 'wrong' } : bot)
    }
    if (body.action === 'execution-settings.chooseBotModel') {
      d.counts.choose++; assert.deepEqual(body.args, [d.createdId, b.prechooseChoiceId]); d.selected = true
      return rpcResult(d.chosenOverride ?? menu())
    }
    assert.fail('unexpected normal action ' + body.action)
  }
  const fetchImpl = async (url, init) => {
    const overridden = await d.hook?.(new URL(url), init, { server, b, d })
    return overridden ?? server(url, init)
  }
  return { b, d, p, comment, calls, fetchImpl, freezeEvidence, get evidence() { return evidence } }
}
async function runCapture(f, options = {}) {
  const state = newState(), budget = createSetupBudget(f.b, options.budgetOptions ?? { totalMs: 5000, cleanupReserveMs: 1000, signoutReserveMs: 100 })
  const client = createSetupClient(f.b, state, budget, f.fetchImpl), clear = client.clear
  client.clear = () => { f.d.counts.clear++; clear() }
  try {
    const report = await capture(client, env, f.b, state, f.p, { budget,
      pin: async phase => { f.d.counts.pins++; return options.pin ? options.pin(phase, state) : { checked: true } } })
    return { report, state, budget }
  } finally { budget.dispose(); assert.equal(budget.activeTimers, 0); assert.equal(f.d.counts.clear, 1) }
}

test('review draft is closed, and the same suite accepts complete compiled bindings while rejecting every partial grant', () => {
  const values = Object.values(BINDING)
  if (values.every(value => value === null)) assert.throws(() => checkBinding(), { code: 'binding_refused' })
  else { assert.equal(values.some(value => value === null), false); assert.equal(checkBinding(), BINDING) }
  const { b } = fixture(); assert.equal(checkBinding(b), b)
  for (const key of Object.keys(b)) assert.throws(() => checkBinding({ ...b, [key]: null }), { code: 'binding_refused' })
})
test('only the exact actual source child of the approved parent can use the one push grant', () => {
  const { b } = fixture()
  guardContext(env, event, env.GITHUB_SHA, [b.opsParentSha], false, b)
  for (const parents of [[], ['c'.repeat(40)], [b.opsParentSha, 'e'.repeat(40)]])
    assert.throws(() => guardContext(env, event, env.GITHUB_SHA, parents, false, b))
  for (const key of ['forced', 'deleted']) assert.throws(() => guardContext(env, { ...event, [key]: true }, env.GITHUB_SHA, [b.opsParentSha], false, b))
  assert.throws(() => guardContext(env, { ...event, before: 'c'.repeat(40) }, env.GITHUB_SHA, [b.opsParentSha], false, b))
  assert.throws(() => guardContext(env, event, env.GITHUB_SHA, [b.opsParentSha], true, b))
  for (const [key, value] of Object.entries({ GITHUB_RUN_ATTEMPT: '2', GITHUB_ACTOR: 'another-user', GITHUB_TRIGGERING_ACTOR: 'another-user',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_JOB: 'publication_preflight', GITHUB_SHA: 'a'.repeat(40),
    GITHUB_WORKFLOW_REF: env.GITHUB_WORKFLOW_REF.replace('publication-setup', 'publication-preflight') }))
    assert.throws(() => guardContext({ ...env, [key]: value }, event, env.GITHUB_SHA, [b.opsParentSha], false, b))
  assert.throws(() => guardContext(env, { ...event, repository: { id: 1, owner: { id: 183887963 } } }, env.GITHUB_SHA, [b.opsParentSha], false, b))
})
test('source admission proves exact served main, latest actual grant and all five runtime states idle', async () => {
  const f = fixture(), budget = createSetupBudget(f.b)
  try { const p = await guardMain(env, f.b, f.fetchImpl, budget, 'work', 180000); assert.equal(p.officialRuntimeIdle, true)
    assert.equal(f.calls.filter(row => row.path.endsWith('/e2b-official-runtime.yml/runs')).length, 5) }
  finally { budget.dispose() }
})
for (const [label, change, code] of [
  ['main drift', f => { f.d.main.object.sha = 'e'.repeat(40) }, 'main_changed'],
  ['served drift', f => { f.d.version.build = 'e'.repeat(40) }, 'build_changed'],
  ['different latest comment', f => { f.comment.id++ }, 'window_changed'],
  ['edited comment', f => { f.comment.body += '\nchanged' }, 'window_changed'],
  ['runtime active', f => { f.d.runtime = { total_count: 1, workflow_runs: [{}] } }, 'runtime_active'],
]) test('source admission rejects ' + label + ' before any normal session', async () => {
  const f = fixture(); change(f); const budget = createSetupBudget(f.b)
  try { await assert.rejects(guardMain(env, f.b, f.fetchImpl, budget), { code }); assert.equal(f.calls.some(row => row.path.includes('/auth/')), false) }
  finally { budget.dispose() }
})
test('a completed blocked preflight is an explicit setup input; a failed capture or unknown blocker is not', () => {
  const f = fixture(); assert.equal(validatePreflight(f.evidence.bytes, f.evidence.receipt, f.b).status, 'preflight_blocked')
  for (const mutate of [p => { p.status = 'failed' }, p => { p.cleanup.signedOut = false }, p => { p.executionBudget.timersClosed = false },
    p => { p.inventory.blockers = ['unknown'] }, p => { p.inventory.blockers = [] }, p => { p.inventory.configurationReady = true },
    p => { p.inventory.claudeChatChoice.menuObservation.choiceId = id(999) }]) {
    const x = fixture(); mutate(x.p); x.freezeEvidence(); assert.throws(() => validatePreflight(x.evidence.bytes, x.evidence.receipt, x.b), { code: 'preflight_refused' })
  }
})
test('preflight actual run, artifact digest and immutable collector source must all match before credentials', async () => {
  const f = fixture(), budget = createSetupBudget(f.b)
  try { assert.equal((await verifyPreflightSource(env, f.b, f.fetchImpl, budget)).artifactId, f.b.preflightArtifactId) }
  finally { budget.dispose() }
  for (const change of [d => { d.run.run_attempt = 2 }, d => { d.run.conclusion = 'success' }, d => { d.run.head_sha = 'd'.repeat(40) },
    d => { d.artifact.digest = 'sha256:' + '0'.repeat(64) }, d => { d.artifact.expired = true }, d => { d.source += 'changed' }]) {
    const x = fixture(change), bounded = createSetupBudget(x.b)
    // The expected immutable source is fixed before a source-tampering observation.
    x.b.preflightSourceSha256 = hash('synthetic-immutable-preflight-source')
    try { await assert.rejects(verifyPreflightSource(env, x.b, x.fetchImpl, bounded), { code: 'preflight_refused' }) }
    finally { bounded.dispose() }
  }
})
test('actual bounded normal wire creates only the new Bot, selects the real deduplicated option and creates one read-back Profile', async () => {
  const f = fixture(d => { d.selectedId = id(195) }), { report } = await runCapture(f)
  assert.equal(report.status, 'setup_ready'); const { sourceCorrelation, ...choice } = report.record.choice
  assert.deepEqual(choice, { requestedId: id(94), acknowledgedId: id(195),
    selectedId: id(195), deduplicated: true, connectionId: id(92), provider: 'claude', model: 'claude-haiku-5-5' })
  assert.equal(sourceCorrelation.status, 'correlated_unique_directories'); assert.equal(sourceCorrelation.menuObservation.readTarget, 'new_owned_bot')
  assert.match(sourceCorrelation.limitation, /^menu_does_not_expose_connection_or_owner_ids/)
  assert.equal(report.record.profile.created, true); assert.equal(report.record.profile.id, id(93))
  assert.equal(report.cleanup.botRetained, true); assert.equal(report.cleanup.botDeleteSupported, false)
  assert.equal(report.cleanup.botIdleConfirmed, true); assert.equal(report.cleanup.signedOut, true)
  assert.deepEqual([f.d.counts.createBot, f.d.counts.choose, f.d.counts.createProfile, f.d.counts.archive], [1, 1, 1, 0])
  assert.equal(f.calls.some(row => /saveIssue|sendCoordinatorMessage|setModelOrder/.test(row.action ?? '')), false)
  const publicBytes = JSON.stringify(report)
  for (const forbidden of [reader, admin, adminName, env.SMOKE_OWNER_PASSWORD, 'synthetic-private-prompt', 'synthetic-private-message-never-emit', f.b.botName])
    assert.equal(publicBytes.includes(forbidden), false, forbidden)
})
test('an already available exact pure fixed Profile is reused without creating or changing one', async () => {
  const f = fixture((d, b, { profile }) => { const p = profile(); d.profiles.push(p); b.enabledProfilePins = [pinOf(p)]; b.profileDecision = { mode: 'reuse', ...pinOf(p) } })
  const { report } = await runCapture(f)
  assert.equal(report.status, 'setup_ready'); assert.equal(report.record.profile.created, false)
  assert.equal(f.d.counts.createProfile, 0); assert.equal(f.d.counts.archive, 0)
})
test('a newly eligible existing Profile makes the compiled create decision stale before Bot creation', async () => {
  const f = fixture((d, b, { profile }) => { const p = { ...profile(), id: id(130) }; d.profiles.push(p); b.enabledProfilePins = [pinOf(p)] })
  const { report } = await runCapture(f)
  assert.equal(report.failure.code, 'profile_reuse_required'); assert.equal(f.d.counts.createBot, 0)
})
test('resource source drift, same-name ambiguity and foreign tenant each stop before creating a Bot', async () => {
  for (const change of [d => { d.order.candidates[0].credentialOwnerId = 'foreign' }, d => { d.workspace.workspace.id = id(999) },
    d => { d.session.user.id = 'foreign' }, (d, b) => { d.bots.push({ id: id(190), name: b.botName, color: 'gris', shape: 'cercle' }) },
    d => { d.order.candidates.push(copy(d.order.candidates[0])) }]) {
    const f = fixture(change), { report } = await runCapture(f)
    assert.equal(report.status, 'failed'); assert.equal(f.d.counts.createBot, 0); assert.equal(report.cleanup.signedOut, true)
  }
})
test('a preference with no reachable approved-model API key is allowed, and a real matching fallback is rejected', async () => {
  const safe = fixture(d => { d.keys = { apiKeyAfterQuota: true, keys: [{ provider: 'openai', protocol: 'openai', models: ['unrelated-model'] }] } })
  assert.equal((await runCapture(safe)).report.status, 'setup_ready')
  const unsafe = fixture(d => { d.keys = { apiKeyAfterQuota: true, keys: [{ provider: 'anthropic', protocol: 'anthropic', models: ['claude-haiku-5-5'] }] } })
  assert.equal((await runCapture(unsafe)).report.failure.code, 'resource_changed'); assert.equal(unsafe.d.counts.createBot, 0)
})
test('a known server-generated Bot ID survives a malformed ACK, and its normal readback stays required', async () => {
  const f = fixture(d => { d.badCreateAck = true }), { report } = await runCapture(f)
  assert.equal(report.failure.code, 'bot_invalid'); assert.equal(report.record.botId, id(91)); assert.equal(report.cleanup.botIdleConfirmed, true)
  assert.equal(f.d.counts.createBot, 1); assert.equal(f.d.counts.choose, 0)
})
test('lost Bot create reply is never re-POSTed and only a unique new own-name inventory plus GET can recover its ID', async () => {
  const f = fixture(d => { d.unknownBot = true }), { report } = await runCapture(f)
  assert.equal(report.failure.code, 'bot_create_uncertain'); assert.equal(report.record.botId, id(91)); assert.equal(report.cleanup.botRetained, true)
  assert.equal(f.d.counts.createBot, 1); assert.equal(f.d.counts.choose, 0)
  const ambiguous = fixture(d => { d.unknownBot = true; d.duplicateCreated = true }), bad = await runCapture(ambiguous)
  assert.equal(bad.report.record.botId, undefined); assert.equal(bad.report.cleanup.botReadbackFailure.code, 'bot_invalid')
  assert.equal(ambiguous.d.counts.createBot, 1); assert.equal(ambiguous.d.counts.choose, 0)
})
test('a chosen menu fallback or different model never authorizes a Profile creation', async () => {
  for (const mutate of [m => { m.current.fallback = 'api-key' }, m => { m.current.modelId = 'wrong' }, m => { m.current.chosen = false }]) {
    const f = fixture((d, _b, { menu }) => { d.hook = (url, init) => {
      if (url.pathname === '/mikka/api/rpc' && JSON.parse(init.body).action === 'execution-settings.chooseBotModel') {
        d.selected = true; d.counts.choose++; const m = menu(); mutate(m); return rpcResult(m)
      }
    } }), { report } = await runCapture(f)
    assert.equal(report.failure.code, 'choice_refused'); assert.equal(f.d.counts.createProfile, 0); assert.equal(report.cleanup.botRetained, true)
  }
})
test('Profile 201 plus matching GET is required, and a confirmed new Profile can be archived after failed readback', async () => {
  const f = fixture(d => { d.badReadbackOnce = true }), { report } = await runCapture(f)
  assert.equal(report.failure.code, 'profile_refused'); assert.equal(report.cleanup.profileArchived, true)
  assert.equal(report.cleanup.archivedProfile.version, 2); assert.equal(f.d.counts.archive, 1); assert.equal(report.cleanup.profileRetained, false)
})
test('an uncertain Profile create is recorded but never retried or claimed as a confirmed archive target', async () => {
  const f = fixture(d => { d.unknownProfile = true }), { report } = await runCapture(f)
  assert.equal(report.failure.code, 'profile_create_uncertain'); assert.equal(report.record.proposedProfileId, id(93))
  assert.equal(report.cleanup.profileCreationUncertain, true); assert.equal(f.d.counts.createProfile, 1); assert.equal(f.d.counts.archive, 0)
})
test('all enabled Profile pins remain fixed; an added enabled Profile cannot be hidden behind own success', async () => {
  const f = fixture((d, _b, { profile }) => { d.hook = (url, init) => {
    if (url.pathname === '/mikka/api/factory/agent-profiles' && (init.method ?? 'GET') === 'GET' && d.counts.createProfile) {
      if (!d.profiles.some(p => p.id === id(130))) d.profiles.push({ ...profile(), id: id(130) })
    }
  } }), { report } = await runCapture(f)
  assert.equal(report.failure.code, 'resource_changed'); assert.equal(report.cleanup.profileArchived, true)
  assert.equal(f.d.profiles.find(p => p.id === id(130)).enabled, true, 'the other profile was not mutated')
})
test('after source failure, cleanup uses its independent allowance and archives only exact known untouched own Profile', async () => {
  const f = fixture(), { report } = await runCapture(f, { pin: (phase, state) => {
    if (phase === 'work' && state.profileCreated) throw Object.assign(new Error('main_changed'), { code: 'main_changed' }); return { checked: true }
  } })
  assert.equal(report.failure.code, 'main_changed'); assert.equal(report.cleanup.profileArchived, true); assert.equal(report.cleanup.signedOut, true)
})
test('new own activity or a changed profile version refuses cleanup without masking the initiating failure', async () => {
  for (const mutate of [d => { d.threads.push({ id: id(198), status: 'running' }) }, d => { d.profiles[0].version++ }]) {
    const f = fixture(), { report } = await runCapture(f, { pin: (phase, state) => {
      if (phase === 'work' && state.profileCreated) { mutate(f.d); throw Object.assign(new Error('main_changed'), { code: 'main_changed' }) }
      return { checked: true }
    } })
    assert.equal(report.failure.code, 'main_changed'); assert.equal(f.d.counts.archive, 0); assert.equal(report.cleanup.profileRetained, true)
    assert.ok(report.cleanup.profileArchiveFailure); assert.equal(report.cleanup.signedOut, true)
  }
})
test('signout failure does not erase a previous source failure or prevent the known resources from being recorded', async () => {
  const f = fixture(d => { d.failSignout = true }), { report } = await runCapture(f, { pin: (phase, state) => {
    if (phase === 'work' && state.profileCreated) throw Object.assign(new Error('main_changed'), { code: 'main_changed' }); return { checked: true }
  } })
  assert.equal(report.status, 'failed'); assert.equal(report.failure.code, 'main_changed'); assert.equal(report.cleanup.signedOut, false)
  assert.equal(report.cleanup.profileArchived, true); assert.equal(report.record.botId, id(91))
})
test('transport refuses null/foreign choice, Tasks, other Profiles, arbitrary URL and duplicate mutation', () => {
  const { b } = fixture(), state = newState(); state.botId = id(91); state.verifiedBotId = id(91)
  const url = 'https://app.aspectlylabs.com/mikka/api/rpc'
  for (const [action, args] of [['execution-settings.chooseBotModel', [null, id(94)]], ['execution-settings.chooseBotModel', [id(999), id(94)]],
    ['execution-settings.chooseBotModel', [id(91), 'apikey:arbitrary']], ['issues.saveIssue', [{}]],
    ['coordinator.sendCoordinatorMessage', [id(91), 'prompt']], ['model-order.setModelOrder', [id(90), []]]])
    assert.throws(() => assertSetupRequest(url, request(action, args), b, state), { code: 'request_refused' })
  assert.throws(() => assertSetupRequest('https://foreign.invalid/mikka/api/rpc', request('bots.pollBots', []), b, state), { code: 'request_refused' })
  assert.throws(() => assertSetupRequest('https://app.aspectlylabs.com/mikka/api/bots/' + id(999), { headers: { 'x-mikka-workspace-id': id(90) } }, b, state), { code: 'request_refused' })
  assertSetupRequest(url, request('execution-settings.chooseBotModel', [id(91), id(94)]), b, state)
  assert.throws(() => assertSetupRequest(url, request('execution-settings.chooseBotModel', [id(91), id(94)]), b, state), { code: 'duplicate_mutation' })
})
test('the real entry verifies artifact and all source pins, then closes every timer after normal setup', async () => {
  const f = fixture(), report = await executeSetup('capture', env, f.b, { fetchImpl: f.fetchImpl, evidence: f.evidence,
    budgetOptions: { totalMs: 5000, cleanupReserveMs: 1000, signoutReserveMs: 100 } })
  assert.equal(report.status, 'setup_ready'); assert.equal(report.executionBudget.timersClosed, true)
  assert.equal(f.calls.filter(row => row.path.endsWith('/git/ref/heads/main')).length, 6)
})
test('the overall budget starts at first guard and cancels a stalled source body before credentials', async () => {
  const f = fixture(); let cancelled = 0, signal
  const began = performance.now()
  await assert.rejects(executeSetup('capture', env, f.b, { evidence: f.evidence,
    budgetOptions: { totalMs: 220, cleanupReserveMs: 90, signoutReserveMs: 40 }, fetchImpl: async (_url, init) => {
      signal = init.signal; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')) }, cancel() { cancelled++ } }))
    } }), { code: 'budget_exhausted' })
  assert.ok(performance.now() - began >= 80); assert.equal(signal.aborted, true); assert.equal(cancelled, 1)
  assert.equal(f.d.counts.createBot, 0)
})
test('work timeout cannot suppress independent cleanup/signout or let an ignored late fetch install a cookie', async () => {
  const f = fixture(), budget = createSetupBudget(f.b, { totalMs: 260, cleanupReserveMs: 140, signoutReserveMs: 70 }), state = newState()
  let cancelled = 0, calls = 0
  const client = createSetupClient(f.b, state, budget, async (_url, init) => {
    calls++
    if (calls === 1) { await delay(170); return new Response(new ReadableStream({ cancel() { cancelled++ } }),
      { headers: { 'set-cookie': 'late=must-not-be-installed' } }) }
    assert.equal(init.signal.aborted, false); assert.equal(new Headers(init.headers).has('cookie'), false); return Response.json({})
  })
  try {
    await assert.rejects(client.exchange('/api/auth/sign-in/email', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: env.SMOKE_OWNER_EMAIL, password: env.SMOKE_OWNER_PASSWORD, rememberMe: false }) }))
    await assert.rejects(client.json('/api/auth/get-session')); assert.equal(calls, 1, 'expired work cannot send a later request')
    budget.enterCleanup(); budget.enterSignout()
    await delay(60)
    assert.equal((await client.exchange('/api/auth/sign-out', { method: 'POST', body: '{}' })).status, 200)
    assert.equal(cancelled, 1)
  } finally { client.clear(); budget.dispose(); assert.equal(budget.activeTimers, 0) }
})
test('only closed error codes are emitted, and raw bodies or credentials cannot become diagnostics', () => {
  assert.deepEqual(publicFailure(new Error('secret token body')), { code: 'setup_failed' })
  assert.deepEqual(publicFailure({ cause: { code: 'main_changed', message: 'never emit' } }), { code: 'main_changed' })
})
test('workflow stays disabled while unbound, and all guards precede the two exact credential reads', async () => {
  const yml = await readFile(new URL('../../.github/workflows/issue1782-publication-setup.yml', import.meta.url), 'utf8').catch(() => '')
  if (Object.values(BINDING).every(value => value === null)) assert.match(yml, /if: false/)
  else { checkBinding(); assert.match(yml, /if: (?:true|false)/) }
  assert.match(yml, /group: production-smoke-owner-acceptance/)
  assert.match(yml, /cancel-in-progress: false/); assert.match(yml, /queue: max/)
  assert.ok(yml.indexOf('publication-setup-1782.mjs verify') < yml.indexOf('secret-name: SMOKE_OWNER_EMAIL'))
  assert.equal((yml.match(/secret-name:/g) ?? []).length, 2); assert.doesNotMatch(yml, /E2B_API_KEY|DATABASE_URL|contents: write|actions: write/)
  assert.match(yml, /timeout-minutes: 3\n        run: node scripts\/ops\/publication-setup-1782.mjs capture/)
})

// Fixture-only exports let the independent root review execute this exact normal
// wire with a fully compiled synthetic binding without reaching any service.
export { fixture }
