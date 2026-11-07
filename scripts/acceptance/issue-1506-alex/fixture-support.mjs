// Offline driver fixture only; never imported by a production entry point.
import assert from 'node:assert/strict'
import { ALEX_OWNER_ID } from '../issue-1506-readonly/alex-session.mjs'
import { ref, workspaceName, workspaceSlug } from './workspace-setup.mjs'
import { FIXTURE_MODELS, fixtureName } from './coordinator-fixtures.mjs'

export const SHA = '3fbb10efeddb57656284d561e814b8f8d41e76fe'
export const RUN_KEY = 'gha-1506001'
export const WORKSPACE_ID = '99999999-9999-4999-8999-999999999999'
export const BOT_IDS = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
export const OPTION_IDS = ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
export const PRIVATE = 'PRIVATE_CANARY_DO_NOT_REPORT'
export const workspaceReceipt = () => ({ schemaVersion: 1, issue: 1506, phase: 'alex-1506-workspace', status: 'ready',
  ownerRef: ref(ALEX_OWNER_ID), runKey: RUN_KEY, applicationSha: SHA,
  workspace: { id: WORKSPACE_ID, ref: ref(WORKSPACE_ID), kind: 'team', name: workspaceName(RUN_KEY), slug: workspaceSlug(RUN_KEY) },
  shares: { subscription: true, allowOthers: false, credit: true } })
export const fixtureReceipt = () => ({ schemaVersion: 1, issue: 1506, phase: 'alex-coordinator-fixtures', status: 'ready',
  ownerRef: ref(ALEX_OWNER_ID), runKey: RUN_KEY, applicationSha: SHA, workspace: workspaceReceipt().workspace,
  fixtures: FIXTURE_MODELS.map((model, index) => ({ ...model, botId: BOT_IDS[index], optionId: OPTION_IDS[index],
    createAttempted: true, selectionAttempted: true, status: 'ready' })) })

export function fakeSession({ readyWorkspace = true, readyBots = false, wrongOwner = false, extraMember = false,
  lostWorkspaceAck = false, lostBotAck = false, lostSelectionAck = false, wrongBotOwner = false,
  fallback = false, busy = false, stream = 'text', noEof = false, afterActive = false, sendLost = false } = {}) {
  const state = { sessions: 0, creates: 0, botCreates: 0, choices: 0, switches: 0, subWrites: 0, creditWrites: 0,
    sends: 0, stops: 0, syncs: 0, hidden: [], signouts: 0, actions: [], eof: false, clientCancelled: false, liveClosed: false }
  let hasWorkspace = readyWorkspace, selected = false, sub = false, credit = false, controller = null, ended = false, run = null
  const bots = readyBots ? BOT_IDS.map((id, index) => ({ id, ownerId: ALEX_OWNER_ID, workspaceId: WORKSPACE_ID, name: fixtureName(RUN_KEY, FIXTURE_MODELS[index].key) })) : []
  const choices = new Map(readyBots ? BOT_IDS.map((id, index) => [id, OPTION_IDS[index]]) : [])
  const requests = []
  const provider = async (work, options) => {
    state.sessions++
    assert.ok(options.expectedSha === null || options.expectedSha === SHA)
    try {
      return await work({ identity: { userId: wrongOwner ? 'XjTsvV1ASqtV8wWat9aco0Z0KLodd9jJ' : ALEX_OWNER_ID },
        version: { build: SHA }, requests,
        async request(path, input = {}) {
          const route = path.split('?')[0]
          let result, response
          if (route === '/api/version') response = Response.json({ build: SHA })
          else if (route === '/api/workspace/switcher') response = Response.json({ workspace: { id: selected ? WORKSPACE_ID : '4ae2a643-b09e-43eb-816c-1e5557bef170' },
            accounts: [{ id: ALEX_OWNER_ID, email: PRIVATE, choices: [
              { id: '4ae2a643-b09e-43eb-816c-1e5557bef170', kind: 'personal', name: PRIVATE },
              ...(hasWorkspace ? [{ id: WORKSPACE_ID, kind: 'team', name: workspaceName(RUN_KEY) }] : []),
            ] }] })
          else if (route === '/api/workspace') {
            assert.equal(path, '/api/workspace?workspace=' + WORKSPACE_ID)
            response = Response.json({ workspace: { id: WORKSPACE_ID, kind: 'team', name: workspaceName(RUN_KEY) }, currentUserId: ALEX_OWNER_ID, role: 'admin',
              members: [{ userId: ALEX_OWNER_ID, role: 'admin', status: 'active', name: PRIVATE, email: PRIVATE },
                ...(extraMember ? [{ userId: PRIVATE, role: 'member', status: 'active' }] : [])], invitations: [] })
          } else if (route === '/api/bots') {
            if (input.body) {
              const index = state.botCreates++
              assert.ok(index < 2, 'no duplicate bot create')
              assert.equal(input.body.name, fixtureName(RUN_KEY, FIXTURE_MODELS[index].key))
              const bot = { id: BOT_IDS[index], ownerId: ALEX_OWNER_ID, workspaceId: WORKSPACE_ID, name: input.body.name }
              bots.push(bot)
              if (lostBotAck) throw new Error(PRIVATE)
              response = Response.json(bot)
            } else response = Response.json(bots.map(bot => ({ ...bot, ...(wrongBotOwner ? { ownerId: PRIVATE } : {}) })))
          } else if (route === '/api/conversations') {
            assert.equal(path, '/api/conversations?workspaceId=' + WORKSPACE_ID)
            response = Response.json({ conversations: [] })
          } else if (route.startsWith('/api/mobile/bots/')) {
            assert.equal(input.method, 'PATCH'); assert.deepEqual(input.body, { hidden: true })
            const id = route.split('/').at(-1); assert.ok(BOT_IDS.includes(id)); state.hidden.push(id)
            response = Response.json({ ok: true })
          } else if (route === '/api/rpc') {
            const { action, args } = input.body; state.actions.push(action)
            assert.equal(input.headers['x-mikka-rpc'], '1')
            if (action === 'workspace.createWorkspace') {
              state.creates++; assert.equal(state.creates, 1); hasWorkspace = true; selected = true
              assert.deepEqual(args, [{ name: workspaceName(RUN_KEY), slug: workspaceSlug(RUN_KEY) }])
              if (lostWorkspaceAck) throw new Error(PRIVATE)
              result = { ok: true, data: { workspaceId: WORKSPACE_ID, slug: workspaceSlug(RUN_KEY) } }
            } else if (action === 'workspace.switchWorkspace') { assert.deepEqual(args, [WORKSPACE_ID]); state.switches++; selected = true
              result = { ok: true, data: { workspaceId: WORKSPACE_ID } }
            } else if (action === 'workspace-settings.getWorkspaceGeneral') result = { id: WORKSPACE_ID, name: workspaceName(RUN_KEY), slug: workspaceSlug(RUN_KEY), personal: false, canEdit: true, canTransfer: true }
            else if (action === 'personal-policy.getSubscriptionShare') result = { personal: false, shared: sub, allowOthers: false, allowed: true, own: ['claude', 'codex'] }
            else if (action === 'personal-policy.updateSubscriptionShare') { assert.deepEqual(args, [{ shared: true, allowOthers: false }, WORKSPACE_ID]); state.subWrites++; sub = true; result = {} }
            else if (action === 'personal-policy.getCreditShare') result = { mine: credit, canShare: true, admin: true, sharers: [PRIVATE] }
            else if (action === 'personal-policy.updateCreditShare') { assert.deepEqual(args, [true, WORKSPACE_ID]); state.creditWrites++; credit = true; result = {} }
            else if (action === 'model-order.getModelOrder') result = { candidates: FIXTURE_MODELS.map((model, index) => ({ model: model.model, provider: model.provider,
              source: { kind: 'subscription', connectionId: index ? '6223f3e1-d626-4eb7-ab62-34dcf3fbfd0c' : 'f83147d9-7e88-4509-a74e-14f22df5c214' } })) }
            else if (action === 'execution-settings.getBotModelMenu' || action === 'execution-settings.chooseBotModel') {
              assert.ok(BOT_IDS.includes(args[0])); const botIndex = BOT_IDS.indexOf(args[0])
              if (action === 'execution-settings.chooseBotModel') {
                assert.equal(args[1], OPTION_IDS[botIndex]); state.choices++; choices.set(args[0], args[1])
                if (lostSelectionAck) throw new Error(PRIVATE)
              }
              const selectedId = choices.get(args[0]) ?? OPTION_IDS[0], selectedIndex = OPTION_IDS.indexOf(selectedId)
              result = { groups: FIXTURE_MODELS.map((model, index) => ({ kind: 'subscription', provider: model.provider,
                owner: PRIVATE, credentialLabel: PRIVATE, options: [{ id: OPTION_IDS[index], modelId: model.model, provider: model.provider }] })),
                current: { id: selectedId, modelId: FIXTURE_MODELS[selectedIndex].model, provider: FIXTURE_MODELS[selectedIndex].provider,
                  kind: 'subscription', chosen: choices.has(args[0]), available: true, ...(fallback ? { fallback: 'quota' } : {}) } }
            } else if (action === 'coordinator.syncCoordinatorChat') {
              state.syncs++; assert.ok(BOT_IDS.includes(args[0]), 'no null or existing Coordinator chat')
              result = { chat: { botId: args[0], enabled: true, working: state.sends ? afterActive : busy,
                ...((state.sends && afterActive) || !state.sends && busy ? { streamRunId: run ?? 'wrun_preexisting' } : {}),
                cursor: state.sends * 2, persistedStreamIds: state.sends ? [run + ':0'] : [], error: null,
                items: state.sends ? [{ streamId: run + ':0', position: state.sends * 2, from: 'coordinator', text: '42', stopped: state.stops > 0 }] : [],
                live: { ownerId: ALEX_OWNER_ID, workspaceId: WORKSPACE_ID, revisions: { ['bot_chat:' + args[0]]: 10 + state.sends } } } }
            } else if (action === 'coordinator.sendCoordinatorMessage') {
              assert.ok(BOT_IDS.includes(args[2])); assert.equal(args[1], null)
              if (state.sends) assert.ok(state.eof || state.clientCancelled, 'previous reader must be released before another send')
              state.sends++; run = 'wrun_fixture' + state.sends; state.eof = false; state.clientCancelled = false; ended = false
              if (sendLost) throw new Error(PRIVATE)
              result = { queued: true }
            } else if (action === 'coordinator.stopCoordinatorTurn') {
              assert.ok(BOT_IDS.includes(args[0])); state.stops++; result = { stopped: true }
              if (controller && !ended && !noEof) { controller.close(); ended = true; state.eof = true }
            } else assert.fail('unexpected or unsafe action: ' + action)
            response = Response.json({ ok: true, result })
          } else if (route === '/api/coordinator/stream') {
            assert.ok(BOT_IDS.some(id => path === '/api/coordinator/stream?wait=1&botId=' + id))
            const turn = run + ':0'
            response = new Response(new ReadableStream({ start(value) {
              controller = value
              const frames = [{ type: 'start', id: turn, sequence: 1 }, stream === 'tool'
                ? { type: 'tool', id: turn, sequence: 2, name: 'web_search', call: PRIVATE, state: 'running', input: PRIVATE }
                : { type: 'text', id: turn, sequence: 2, delta: '42' }]
              if (stream === 'complete') frames.push({ type: 'committed', id: turn, sequence: 3, through: state.sends * 2, quiet: false })
              const bytes = new TextEncoder().encode(frames.map(frame => JSON.stringify(frame)).join('\n') + '\n')
              for (let i = 0; i < bytes.length; i += 13) controller.enqueue(bytes.slice(i, i + 13))
              if (stream === 'complete' && !noEof) { controller.close(); ended = true; state.eof = true }
            }, cancel() { ended = true; state.clientCancelled = true } }), { headers: { 'content-type': 'application/x-ndjson', 'x-mikka-stream-run': run, 'x-mikka-stream-key': PRIVATE } })
          } else assert.fail('unexpected path: ' + path)
          requests.push({ path: '/mikka' + route, method: input.method ?? (input.body ? 'POST' : 'GET'), status: response.status, headersMs: 0 })
          return response
        } })
    } finally { state.signouts++; requests.push({ path: '/mikka/api/auth/sign-out', method: 'POST', status: 200, headersMs: 0 }) }
  }
  const openLive = async () => {
    const summary = { ready: true, revisionCapable: true, baselineRevision: 10, matchingPushes: 0, versionedPushes: 0, newerPushes: 0, maxRevision: 10, closed: false }
    return { summary, get revision() { return summary.maxRevision }, subscribe() { return () => {} },
      begin() { summary.matchingPushes++; summary.versionedPushes++; summary.newerPushes++; summary.maxRevision++ },
      async close() { state.liveClosed = true; summary.closed = true; return true } }
  }
  return { state, provider, openLive, options: { env: { MIKKA_ACCEPTANCE_SHA: SHA, MIKKA_FIXTURE_RUN_KEY: RUN_KEY, MIKKA_FIXTURE_KIND: 'haiku' },
    fixtureReceipt: fixtureReceipt(), sessionProvider: provider, openLive, checkpoint: false, streamTimeoutMs: 50, stopTimeoutMs: 30, turnTimeoutMs: 50 } }
}
