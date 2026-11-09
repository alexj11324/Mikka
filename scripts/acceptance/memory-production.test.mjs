import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import yaml from 'js-yaml'
import { encode, decode } from '../../lib/desktop-rpc/wire.ts'
import { clampSubject } from '../../lib/profile/facts.ts'
import { runMemoryProduction, readMemoryTurn } from './memory-production.mjs'
import { MEMORY_BRANCH, MemorySelectionError } from './memory-production-target.mjs'
import { CORE_ISSUES, CORE_MODE, CORE_WORKFLOW, attestCoreProduction } from './self-hosted-production-target.mjs'

const id = value => '50000000-0000-4000-8000-' + String(value).padStart(12, '0')
const TEAM = id(1), PERSONAL = id(2), PROJECT = id(3), EXISTING = id(4), PENDING = id(5), FACT = id(6), OLD_BOT = id(7)
const OWNER = 'owner-private-canary', EMAIL = 'fixture+mikka-smoke@example.invalid', PASSWORD = 'password-private-canary'
const COOKIE = 'cookie-private-canary', SESSION = 'session-private-canary', SHA = 'a'.repeat(40)
const NOW = Date.parse('2026-11-09T22:00:00.000Z')
const response = (value, status = 200, headers = {}) => Response.json(value, { status, headers })
const reply = result => response({ version: 1, ok: true, result: encode(result) })
const denied = (code = 'workspaceAccessDenied', status = 403) => response({ version: 1, ok: false, error: { code, message: PASSWORD, private: COOKIE } }, status)
const stream = events => new Response(events.map(item => JSON.stringify(item)).join('\n') + '\n',
  { headers: { 'content-type': 'application/x-ndjson', 'x-mikka-stream-run': 'wrun_Fixture123' } })
const ownRow = (factId, subject, reviewStatus = 'approved') => ({ id: factId, kind: 'preference', subject, userEdited: true,
  source: { kind: 'told', id: factId, url: null }, reviewStatus, scope: { kind: 'global', ids: [] },
  usedCount: 0, recentUses: [], actions: ['correct', 'remove', 'setScope'], undoUntil: null, state: 'active' })

function fixture(options = {}) {
  const calls = [], receipts = [], facts = new Map([
    [EXISTING, ownRow(EXISTING, 'existing private fact canary')],
    [PENDING, { ...ownRow(PENDING, 'existing pending fact canary', 'pending'), userEdited: false,
      source: { kind: 'file', id: null, url: null }, actions: ['approve', 'reject', 'correct', 'remove', 'setScope'] }],
  ])
  const bots = new Map([[OLD_BOT, { id: OLD_BOT, name: 'existing private bot canary' }]])
  let selected = PERSONAL, loggedIn = false, nonceIndex = 100, targets = 0, requestId, enabled = options.enabled !== false, streamReads = 0, clock = NOW
  const visible = row => row.scope.kind === 'global' || row.scope.kind === 'workspaces' && row.scope.ids.includes(selected)
    || row.scope.kind === 'projects' && selected === TEAM && row.scope.ids.includes(PROJECT)
  const view = () => {
    const rows = [...facts.values()].filter(visible).map(({ state: _state, snapshot: _snapshot, ...row }) => structuredClone(row))
    const active = rows.filter(row => facts.get(row.id).state === 'active')
    return { enabled, total: active.filter(row => row.reviewStatus === 'approved').length,
      facts: active.filter(row => row.reviewStatus === 'approved'), pending: active.filter(row => row.reviewStatus === 'pending'),
      undoable: rows.filter(row => facts.get(row.id).state === 'deleted' && Date.parse(row.undoUntil) > NOW),
      scopeOptions: { workspaces: [{ id: TEAM, name: 'Team' }, { id: PERSONAL, name: 'Personal' }],
        projects: !options.noProject && selected === TEAM ? [{ id: PROJECT, name: 'Existing authorized project' }] : [] } }
  }
  const choice = (bot, override = {}) => ({ id: id(bot.harness === 'codex' ? 21 : 20), provider: bot.harness === 'codex' ? 'codex' : 'claude',
    modelId: bot.harness === 'codex' ? 'gpt-6-luna' : 'claude-haiku-5-5', kind: 'subscription', chosen: true, available: true, ...override })
  const menu = bot => ({ groups: [
    { kind: 'subscription', provider: 'claude', owner: 'shared owner private canary', options: [{ id: id(20), provider: 'claude', modelId: 'claude-haiku-5-5' }] },
    { kind: 'subscription', provider: 'codex', owner: 'shared owner private canary', options: [{ id: id(21), provider: 'codex', modelId: 'gpt-6-luna' }] },
  ], current: bot.harness ? choice(bot, options.fallbackHarness === bot.harness ? { fallback: 'quota', kind: 'apiKey' } : {}) : { kind: 'hosted' } })
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input), path = url.pathname.replace(/^\/mikka/, ''), method = init.method ?? 'GET'
    const headers = new Headers(init.headers), body = init.body ? JSON.parse(init.body) : null
    calls.push({ path, method, action: body?.action, args: body?.args ? decode(body.args) : undefined })
    assert.equal(url.origin, 'https://app.aspectlylabs.com'); assert.equal(init.redirect, 'error'); assert.equal(headers.has('authorization'), false)
    if (path === '/api/auth/sign-in/email') {
      assert.deepEqual(body, { email: EMAIL, password: PASSWORD, rememberMe: false }); loggedIn = true
      return response({ user: { id: OWNER } }, 200, { 'set-cookie': 'session=' + COOKIE + '; Path=/; Secure; HttpOnly' })
    }
    if (path === '/api/auth/get-session') {
      assert.equal(url.searchParams.get('disableCookieCache'), 'true')
      return response(loggedIn && headers.get('cookie')?.includes(COOKIE) ? { user: { id: OWNER, email: EMAIL }, session: { id: SESSION } } : null)
    }
    assert.ok(loggedIn && headers.get('cookie')?.includes(COOKIE), 'normal session required')
    if (path === '/api/auth/sign-out') {
      if (!options.ignoreLogout) loggedIn = false
      return response({ success: true }, 200, { 'set-cookie': 'session=; Path=/; Max-Age=0' })
    }
    if (path === '/api/workspace') return response({ currentUserId: OWNER, workspace: { id: selected, kind: selected === TEAM ? 'team' : 'personal' },
      choices: [{ id: TEAM, kind: 'team' }, { id: PERSONAL, kind: 'personal' }] })
    if (path === '/api/integrations/github') {
      assert.equal(method, 'GET')
      if (options.githubFailure) return denied('githubUnavailable', 502)
      return response({ viewerId: options.foreignGitHub ? 'different private owner' : OWNER,
        configured: true, connected: !options.githubMissing, installed: !options.githubMissing,
        login: 'private login canary', repositories: options.githubMissing ? [] : [{ fullName: 'alexj11324/Mikka' }] })
    }
    if (path.startsWith('/api/bots/')) {
      const bot = bots.get(path.slice('/api/bots/'.length)); assert.ok(bot)
      return response({ id: bot.id, name: options.wrongBotName ? 'not the current fixture' : bot.name })
    }
    if (path === '/api/coordinator/stream') {
      const bot = bots.get(url.searchParams.get('botId')); assert.ok(bot?.queued); streamReads++
      if (options.budgetExpiredAfterStream) clock = NOW + 300_001
      if (options.blockedHarness === bot.harness) { bot.error = 'run_quota_exceeded'; return stream([{ type: 'error' }]) }
      if (options.staleProviderCode) bot.error = 'run_quota_exceeded'
      const fact = facts.get(FACT), challenge = fact.subject.match(/(MEMORY1821_[a-f0-9]+)/)[1]
      if (!options.missingUsage) {
        fact.usedCount++; fact.recentUses.unshift({ kind: 'thread', id: bot.id, url: null, usedAt: new Date(NOW).toISOString() })
        facts.get(EXISTING).usedCount++ // a real prompt can also consume another already-approved fact
      }
      return stream([{ type: 'text', id: 'turn', delta: options.wrongReply ? 'MISSING' : challenge }, { type: 'committed', id: 'turn', through: 1, quiet: false }])
    }
    assert.equal(path, '/api/rpc'); assert.equal(body.version, 1); assert.equal(headers.get('x-mikka-rpc'), '1')
    const args = decode(body.args), action = body.action
    if (action === 'workspace.switchWorkspace') { assert.ok([TEAM, PERSONAL].includes(args[0])); selected = args[0]; return reply({ ok: true, data: { workspaceId: selected } }) }
    if (action === 'memory.getMemory') return reply(view())
    if (action === 'memory.addFact') {
      assert.equal(selected, TEAM)
      const value = args[0]
      if (requestId) { assert.equal(value.requestId, requestId); return reply(FACT) }
      requestId = value.requestId
      facts.set(FACT, { ...ownRow(FACT, clampSubject(value.subject)), scope: value.scope })
      if (options.missingManualSource) facts.get(FACT).source.id = null
      if (options.lostCreate) throw new Error(PASSWORD + COOKIE)
      return reply(options.wrongFactId ? EXISTING : FACT)
    }
    if (action.startsWith('memory.')) {
      assert.equal(args[0], FACT, 'only this exact newly bound fact may be mutated')
      const fact = facts.get(FACT); assert.ok(fact)
      if (action === 'memory.setFactScope' && args[1].kind === 'workspaces' && args[1].ids.some(id => ![TEAM, PERSONAL].includes(id))) return denied()
      if (!visible(fact)) return reply(false)
      if (action === 'memory.setFactScope') { fact.scope = args[1]; return reply(true) }
      if (action === 'memory.reviewFact') return reply(true)
      if (action === 'memory.removeFact') {
        if (options.removeFailure) return denied('desktop_rpc_failed', 503)
        if (fact.state === 'active') { fact.snapshot = fact.source; fact.source = null; fact.state = 'deleted'; fact.undoUntil = new Date(NOW + 120_000).toISOString() }
        return reply(true)
      }
      if (action === 'memory.undoRemoveFact') {
        if (options.undoFailure) return reply(false)
        if (fact.state === 'deleted') { fact.state = 'active'; fact.source = fact.snapshot; fact.undoUntil = null }
        return reply(true)
      }
      assert.fail('unexpected memory mutation')
    }
    if (action === 'bots.pollBots') return reply({ items: [...bots.values()].map(({ id, name }) => ({ id, name })), live: { ownerId: OWNER, workspaceId: selected } })
    if (action === 'bots.createBot') {
      assert.equal(selected, TEAM); assert.equal(args[0].model, null); assert.equal(args[0].repository, null)
      assert.match(args[0].name, /^测试1821 /)
      const bot = { id: id(bots.size + 30), name: args[0].name }; bots.set(bot.id, bot)
      if (options.lostBot && bots.size === 2) throw new Error(PASSWORD)
      return reply(options.wrongBotId ? { id: OLD_BOT } : bot)
    }
    if (action === 'execution-settings.getBotModelMenu') { assert.notEqual(args[0], OLD_BOT); return reply(menu(bots.get(args[0]))) }
    if (action === 'execution-settings.chooseBotModel') {
      const bot = bots.get(args[0]); assert.notEqual(bot.id, OLD_BOT); assert.ok([id(20), id(21)].includes(args[1]))
      bot.harness = args[1] === id(21) ? 'codex' : 'claude_code'; return reply({ ok: true, data: menu(bot) })
    }
    if (action === 'coordinator.sendCoordinatorMessage') {
      const bot = bots.get(args[2]); assert.ok(bot); assert.notEqual(bot.id, OLD_BOT)
      assert.equal(args[9], TEAM); assert.equal(args[4], undefined); assert.equal(args[8], undefined)
      assert.match(args[0], /不要调用工具/); assert.equal(args[0].includes('MEMORY1821_'), false, 'the model must retrieve the value, not repeat it from the prompt')
      bot.queued = true; return reply({ ok: true, data: { queued: true } })
    }
    if (action === 'coordinator.pollCoordinatorChat') { const bot = bots.get(args[0]); assert.notEqual(bot.id, OLD_BOT); return reply({ botId: bot.id, working: false, error: bot.error ?? null, items: [] }) }
    if (action === 'coordinator.stopCoordinatorTurn') {
      assert.notEqual(args[0], OLD_BOT)
      if (options.stopFailure) return denied('desktop_rpc_failed', 500)
      return reply({ ok: true, data: { stopped: false } })
    }
    assert.fail('unexpected action ' + action)
  }
  const args = { env: { SMOKE_OWNER_EMAIL: EMAIL, SMOKE_OWNER_PASSWORD: PASSWORD, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' },
    event: {}, attestation: {}, fetchImpl, now: () => clock, nonce: () => id(nonceIndex++),
    assertTarget: async () => {
      targets++
      if (options.targetFailure || options.driftAfterUse && streamReads) throw new Error('target drift ' + PASSWORD)
      return { status: 'ready', applicationSha: SHA, driverRunId: 123, openIssues: options.closed ? [] : [1821] }
    },
    selectTarget: async ({ assertTarget, ...parameters }) => {
      const attestation = await assertTarget(parameters)
      if (options.closed || options.notSelected) return { selected: false, status: 'not_selected', reason: options.closed ? 'memory_issue_closed' : 'not_pr_1830_merge' }
      if (options.windowExpiredAfterCreate && facts.has(FACT)) throw new MemorySelectionError('memory_window_invalid', 'time')
      return { selected: true, status: 'selected', applicationSha: SHA, headSha: 'b'.repeat(40), driverRunId: 123, driverRunAttempt: 1, attestation,
        window: { commentId: 1821001, branch: MEMORY_BRANCH, headSha: 'b'.repeat(40), sourceSha: SHA,
          startsAt: new Date(NOW - 60_000).toISOString(), expiresAt: new Date(NOW + 60_000).toISOString(), markerSha256: 'c'.repeat(64) } }
    },
    selectTeam: async (client, { ownerId }, remember) => {
      assert.equal(ownerId, OWNER); remember(PERSONAL); await client.rpc('workspace.switchWorkspace', [TEAM]); return { workspaceId: TEAM }
    },
    writeReceipt: async value => { receipts.push(structuredClone(value)); if (options.receiptFailure) throw new Error(COOKIE) } }
  return { args, calls, receipts, facts, bots, state: () => ({ selected, loggedIn, targets, streamReads }), run: () => runMemoryProduction(args) }
}
function privateOutput(report) {
  const text = JSON.stringify(report)
  for (const value of [OWNER, EMAIL, PASSWORD, COOKIE, SESSION, 'existing private fact canary', 'existing pending fact canary',
    'existing private bot canary', 'shared owner private canary', FACT, OLD_BOT]) assert.equal(text.includes(value), false, value)
  assert.equal(text.includes('MEMORY1821_'), false)
}

test('owner memory CRUD, scopes, short undo and two real-stream usage contracts remain distinct from missing pending provenance', async () => {
  const f = fixture(), report = await f.run()
  assert.equal(report.status, 'partial', JSON.stringify(report))
  assert.equal(report.completeAcceptance, false)
  assert.equal(report.checks.ownerCrud, true)
  assert.equal(report.coverage.manualSource, 'normal_owner_insert_told_assertion_id')
  assert.equal(report.coverage.pendingList, 'existing_pending_read_only')
  assert.equal(report.coverage.pendingReview, 'not_exercised_no_owned_notification_fixture')
  assert.equal(report.coverage.crossWorkspace, 'hidden_and_mutations_refused_for_own_fixture')
  assert.equal(report.coverage.projectScope, 'existing_authorized_project_scope')
  assert.equal(report.coverage.realUse, 'both_fixed_subscription_bot_replies_and_usage_observed')
  const added = f.calls.find(row => row.action === 'memory.addFact').args[0]
  assert.equal(added.subject.length, 78)
  assert.equal(clampSubject(added.subject), added.subject, 'the actual store must preserve the full nonce and challenge')
  assert.deepEqual(report.models.map(row => [row.harness, row.model, row.status, row.reply, row.usage, row.botStopped]), [
    ['claude_code', 'claude-haiku-5-5', 'passed', true, true, true], ['codex', 'gpt-6-luna', 'passed', true, true, true],
  ])
  assert.ok(['factRemoved', 'originalFactsPreserved', 'preferencePreserved', 'workspaceRestored', 'sessionRevoked'].every(key => report.cleanup[key]))
  assert.equal(f.facts.get(FACT).state, 'deleted'); assert.equal(f.facts.get(FACT).source, null)
  assert.equal(f.facts.get(PENDING).reviewStatus, 'pending'); assert.equal(f.facts.get(EXISTING).usedCount, 2)
  assert.equal(f.state().selected, PERSONAL); assert.equal(f.state().loggedIn, false)
  assert.ok(f.state().targets > 20, 'writes recheck the selected source/window'); assert.equal(f.state().streamReads, 2)
  assert.deepEqual(report.pendingFixture.github, { status: 'read', configured: true, connected: true, installed: true,
    source: 'owner', repositoryCount: 1, mikkaRepositoryListed: true, notificationDelivery: 'not_proven_by_repository_listing' })
  assert.ok(f.receipts.some(row => row.state === 'created')); assert.ok(f.receipts.some(row => row.state === 'normal_soft_delete_confirmed'))
  assert.equal(f.bots.size, 3, 'there is no Bot delete API; only this run’s two stopped Bots are retained')
  privateOutput(report)
})

test('invalid target and a closed memory issue cannot access owner credentials or login', async () => {
  for (const options of [{ targetFailure: true }, { closed: true }, { notSelected: true }]) {
    const f = fixture(options)
    for (const name of ['SMOKE_OWNER_EMAIL', 'SMOKE_OWNER_PASSWORD']) Object.defineProperty(f.args.env, name, { get() { return assert.fail('credentials accessed before target authority') } })
    const report = await f.run()
    assert.equal(report.status, options.closed || options.notSelected ? 'not_selected' : 'failed'); assert.equal(f.calls.length, 0); privateOutput(report)
  }
})

test('an expired selected window prevents the next business write but exact owned cleanup and logout continue', async () => {
  const f = fixture({ windowExpiredAfterCreate: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(f.calls.filter(row => row.action === 'memory.addFact').length, 1)
  assert.equal(f.calls.some(row => row.action === 'coordinator.sendCoordinatorMessage'), false)
  assert.equal(f.facts.get(FACT).state, 'deleted'); assert.equal(f.facts.get(PENDING).reviewStatus, 'pending')
  assert.equal(report.cleanup.factRemoved, true); assert.equal(report.cleanup.workspaceRestored, true)
  assert.equal(report.cleanup.sessionRevoked, true); privateOutput(report)
})

test('a timed-out business budget cannot block stopping an already-created Bot or final owner cleanup', async () => {
  const f = fixture({ budgetExpiredAfterStream: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(f.calls.filter(row => row.action === 'coordinator.sendCoordinatorMessage').length, 1)
  assert.equal(f.calls.filter(row => row.action === 'coordinator.stopCoordinatorTurn').length, 1)
  assert.equal(report.models[0].botStopped, true); assert.equal(report.cleanup.factRemoved, true)
  assert.equal(report.cleanup.workspaceRestored, true); assert.equal(report.cleanup.sessionRevoked, true)
  privateOutput(report)
})

test('GitHub owner inventory is a read-only observation, not proof of notification delivery or permission to create one', async () => {
  for (const options of [{ githubMissing: true }, { githubFailure: true }, { foreignGitHub: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'partial'); assert.equal(report.checks.ownerCrud, true)
    assert.equal(report.pendingFixture.github.status, options.githubMissing ? 'read' : 'read_failed')
    assert.equal(report.pendingFixture.github.connected === true, false)
    assert.equal(f.calls.filter(row => row.path === '/api/integrations/github' && row.method === 'GET').length, 1)
    privateOutput(report)
  }
})

test('a newly created told source needs its real assertion id and a missing locator is not a provenance pass', async () => {
  const f = fixture({ missingManualSource: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.equal(report.coverage.manualSource, 'not_exercised')
  assert.ok(report.failures.some(row => row.code === 'manual_fact_failed'))
  assert.equal(report.cleanup.factRemoved, true); assert.equal(report.cleanup.sessionRevoked, true)
  privateOutput(report)
})

test('the existing disabled memory preference is preserved and never silently enabled for model tests', async () => {
  const f = fixture({ enabled: false, noProject: true }), report = await f.run()
  assert.equal(report.status, 'partial'); assert.equal(report.checks.ownerCrud, true)
  assert.ok(report.models.every(row => row.status === 'blocked' && row.reason === 'existing_memory_preference_disabled'))
  assert.equal(f.calls.some(row => ['memory.setMemory', 'memory.clearMemory', 'bots.createBot', 'model-order.updateModelOrder'].includes(row.action)), false)
  assert.equal(report.cleanup.preferencePreserved, true); privateOutput(report)
})

test('one quota-blocked subscription does not stop the other fixed model or become fabricated usage success', async () => {
  const f = fixture({ blockedHarness: 'claude_code' }), report = await f.run()
  assert.equal(report.status, 'partial')
  assert.deepEqual(report.models.map(row => row.status), ['blocked', 'passed'])
  assert.equal(report.models[0].providerCode, 'run_quota_exceeded'); assert.equal(report.models[0].usage, false)
  assert.equal(report.models[1].usage, true); assert.equal(report.cleanup.factRemoved, true); privateOutput(report)
})

test('a provider code cannot downgrade missing usage after a committed reply to an external blocker', async () => {
  const f = fixture({ missingUsage: true, staleProviderCode: true }), report = await f.run()
  assert.equal(report.status, 'failed')
  assert.ok(report.models.every(row => row.status === 'failed' && row.failure.code === 'usage_not_observed' && row.reply))
  assert.equal(report.cleanup.factRemoved, true); privateOutput(report)
})

test('an API-key fallback is refused before sending that model path, while the other subscription proceeds', async () => {
  const f = fixture({ fallbackHarness: 'claude_code' }), report = await f.run()
  assert.equal(report.status, 'partial'); assert.deepEqual(report.models.map(row => row.status), ['blocked', 'passed'])
  assert.equal(f.calls.filter(row => row.action === 'coordinator.sendCoordinatorMessage').length, 1)
  assert.equal(f.state().streamReads, 1); privateOutput(report)
})

test('a lost create reply is recovered only by this run’s exact nonce and cleanup never touches the original facts', async () => {
  for (const options of [{ lostCreate: true }, { wrongFactId: true }, { undoFailure: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'failed'); assert.equal(report.cleanup.factRemoved, true)
    assert.equal(f.facts.get(EXISTING).state, 'active'); assert.equal(f.facts.get(PENDING).state, 'active')
    assert.equal(f.calls.filter(row => row.action === 'memory.addFact').length, options.undoFailure ? 2 : 1, 'no blind creation retry')
    assert.equal(f.state().loggedIn, false); privateOutput(report)
  }
})

test('wrong Bot responses and lost Bot replies never authorize changing another Bot', async () => {
  for (const options of [{ lostBot: true }, { wrongBotId: true }, { wrongBotName: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'failed'); assert.equal(report.cleanup.factRemoved, true)
    assert.equal(f.calls.some(row => ['coordinator.stopCoordinatorTurn', 'execution-settings.chooseBotModel'].includes(row.action) && row.args[0] === OLD_BOT), false)
    privateOutput(report)
  }
})

test('model reply, usage and deployment drift failures stay failed even after exact fixture cleanup succeeds', async () => {
  for (const options of [{ missingUsage: true }, { wrongReply: true }, { driftAfterUse: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'failed'); assert.equal(report.cleanup.factRemoved, true); assert.equal(report.cleanup.sessionRevoked, true)
    assert.equal(report.completeAcceptance, false); privateOutput(report)
  }
})

test('cleanup and old-cookie failures retain closed HTTP evidence without leaking response bodies', async () => {
  for (const options of [{ removeFailure: true }, { stopFailure: true }, { ignoreLogout: true }]) {
    const f = fixture(options), report = await f.run()
    assert.equal(report.status, 'failed'); assert.ok(report.cleanup.failures.length > 0)
    if (options.removeFailure) assert.ok(report.cleanup.failures.some(row => row.httpStatus === 503 && row.body?.code === 'desktop_rpc_failed'))
    if (options.stopFailure) assert.ok(report.cleanup.failures.some(row => row.httpStatus === 500))
    if (options.ignoreLogout) assert.equal(report.cleanup.sessionRevoked, false)
    privateOutput(report)
  }
})

test('a durable fixture receipt must succeed before the first memory write', async () => {
  const f = fixture({ receiptFailure: true }), report = await f.run()
  assert.equal(report.status, 'failed'); assert.equal(f.calls.some(row => row.action === 'memory.addFact'), false)
  assert.equal(report.cleanup.sessionRevoked, true); privateOutput(report)
})

test('stream success requires a committed exact reply; a tool, provider error or partial text is not success', async () => {
  for (const events of [[{ type: 'text', id: 'a', delta: 'answer' }], [{ type: 'error' }],
    [{ type: 'tool', id: 'a', name: 'dispatch_run', state: 'running', input: PASSWORD }],
    [{ type: 'text', id: 'a', delta: 'incorrect' }, { type: 'committed', id: 'a' }]]) await assert.rejects(readMemoryTurn(stream(events), 'answer'))
  const value = await readMemoryTurn(stream([{ type: 'text', id: 'a', delta: 'wrong' }, { type: 'reset', id: 'a', text: 'answer' }, { type: 'committed', id: 'a' }]), 'answer')
  assert.deepEqual(value, { committedReply: true, workflowFingerprint: createHash('sha256').update('wrun_Fixture123').digest('hex') })
})

test('the normal main/Web guard includes the memory issue without a dispatch or credential bypass', async () => {
  assert.ok(CORE_ISSUES.includes(1821))
  const repository = { full_name: 'alexj11324/Mikka', owner: { login: 'alexj11324' } }, api = 'https://api.github.com/repos/alexj11324/Mikka'
  const env = { MIKKA_ACCEPTANCE_TARGET_MODE: CORE_MODE, GITHUB_REPOSITORY: repository.full_name, GITHUB_REPOSITORY_OWNER: 'alexj11324',
    GITHUB_REF: 'refs/heads/main', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_SHA: SHA, GITHUB_RUN_ID: '17', GITHUB_RUN_ATTEMPT: '1',
    GITHUB_WORKFLOW_REF: repository.full_name + '/' + CORE_WORKFLOW + '@refs/heads/main', GH_TOKEN: 'synthetic-token' }
  const release = { id: 51, run_attempt: 1, repository, head_repository: repository, event: 'push', head_branch: 'main', head_sha: SHA,
    name: 'Web deploy', path: '.github/workflows/web-deploy.yml', status: 'completed', conclusion: 'success', url: api + '/actions/runs/51' }
  const event = { action: 'completed', repository, workflow_run: release }
  const fetchImpl = async input => {
    const url = new URL(input), path = url.href.slice(api.length)
    if (url.origin === 'https://app.aspectlylabs.com') return response({ build: SHA })
    if (path.startsWith('/issues/')) { const number = Number(path.slice(8)); return response({ number, url: url.href, repository_url: api, state: number === 1821 ? 'open' : 'closed' }) }
    if (path === '/actions/runs/17') return response({ id: 17, run_attempt: 1, repository, head_repository: repository,
      url: url.href, path: CORE_WORKFLOW, event: 'workflow_run', head_branch: 'main', head_sha: SHA, status: 'in_progress', conclusion: null })
    if (path === '/git/ref/heads/main') return response({ ref: 'refs/heads/main', object: { type: 'commit', sha: SHA } })
    if (path === '/actions/runs/51') return response(release)
    if (path.endsWith('/attempts/1/jobs?per_page=100')) return response({ total_count: 1, jobs: [{ id: 61, name: 'deploy', run_id: 51, head_sha: SHA,
      status: 'completed', conclusion: 'success', steps: ['Verify the official runtime stays on the cloud edition',
        'Build (runs migrations last, as the Vercel build did)', 'Upload the prebuilt output to production',
        'Verify the public production version before releasing the deployment queue'].map(name => ({ name, status: 'completed', conclusion: 'success' })) }] })
    assert.fail('unexpected target metadata request')
  }
  const proof = await attestCoreProduction({ env, event, fetchImpl, now: () => NOW })
  assert.equal(proof.status, 'ready'); assert.deepEqual(proof.openIssues, [1821])
  await assert.rejects(attestCoreProduction({ env: { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }, event, fetchImpl, now: () => NOW }))
  const workflow = yaml.load(await readFile(new URL('../../.github/workflows/self-hosted-production.yml', import.meta.url), 'utf8'))
  assert.equal(workflow.on.workflow_dispatch, undefined)
  assert.ok(workflow.concurrency.group.includes('production-smoke-owner-acceptance'))
  assert.equal(workflow.concurrency.queue, 'max'); assert.equal(workflow.concurrency['cancel-in-progress'], false)
  assert.ok(workflow.jobs.guards.steps.some(step => step.run?.includes('memory-production.test.mjs')))
  assert.ok(workflow.jobs.acceptance.steps.some(step => step.run === 'node --import tsx scripts/acceptance/memory-production.mjs'))
  assert.deepEqual(Object.keys(workflow.jobs.acceptance.permissions).sort(), ['actions', 'contents', 'id-token', 'issues', 'pull-requests'])
  assert.equal(workflow.jobs.acceptance.permissions['pull-requests'], 'read')
})
