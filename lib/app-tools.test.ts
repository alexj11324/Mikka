import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appCallSetting, callAppTool, explicitSetting, listAppTools, toolSettingKey, type AppTool, type AppToolDeps } from './app-tools'
import { appCallSettingKeys } from './operations/app-permission-keys'

const tools: Record<string, AppTool> = {
  HUBSPOT_LIST_CONTACTS: { slug: 'HUBSPOT_LIST_CONTACTS', name: 'List contacts', tags: ['readOnlyHint'], version: '20261030_00', toolkit: { slug: 'hubspot' }, inputParameters: { type: 'object' } },
  HUBSPOT_CREATE_CONTACT: { slug: 'HUBSPOT_CREATE_CONTACT', name: 'Create contact', tags: ['openWorldHint'], version: '20261030_00', toolkit: { slug: 'hubspot' } },
  HUBSPOT_DELETE_CONTACT: { slug: 'HUBSPOT_DELETE_CONTACT', name: 'Delete contact', tags: ['destructiveHint'], version: '20261030_00', toolkit: { slug: 'hubspot' } },
  SLACK_SEND_MESSAGE: { slug: 'SLACK_SEND_MESSAGE', name: 'Send', tags: [], version: '1', toolkit: { slug: 'slack' } },
  HUBSPOT_UNPINNED: { slug: 'HUBSPOT_UNPINNED', name: 'Unpinned', tags: ['readOnlyHint'], version: 'latest', toolkit: { slug: 'hubspot' } },
}

function deps(overrides: Partial<AppToolDeps> = {}) {
  const calls: string[] = []
  const value: AppToolDeps = {
    appAllowed: async () => true,
    resolveAccount: async () => ({ accountId: 'ca_own', accounts: [{ id: 'ca_own', alias: null }] }),
    listTools: async () => Object.values(tools),
    getTool: async slug => { const tool = tools[slug]; if (!tool) throw new Error('missing'); return tool },
    execute: async call => { calls.push(`execute:${call.tool}:${call.version}`); return { successful: true, data: { id: 'c1' } } },
    setting: async () => null,
    judge: async () => 'allow',
    recordStart: async call => { calls.push(`record:${call.tool}`); return 'rec_1' },
    recordEnd: async (_id, outcome) => { calls.push(`end:${outcome.status}`) },
    propose: async call => { calls.push(`card:${call.tool}`); return { status: 'awaiting_approval', actionId: 'card_1' } },
    ...overrides,
  }
  return { deps: value, calls }
}
const call = (tool: string, toolkit = 'hubspot') => ({ toolkit, tool, arguments: { email: 'a@acme.dev' } })

test('a read-only tool goes to the Decisions judge too; allowed, it runs with the pinned version and no record', async () => {
  const judged: unknown[] = []
  const { deps: d, calls } = deps({ judge: async call => { judged.push(call); return 'allow' } })
  assert.deepEqual(await callAppTool(d, call('HUBSPOT_LIST_CONTACTS')), { data: { id: 'c1' } })
  assert.deepEqual(calls, ['execute:HUBSPOT_LIST_CONTACTS:20261030_00'])
  // readOnlyHint is evidence the judge reads, not a rule that skips it.
  assert.deepEqual(judged, [{ action: 'hubspot_list_contacts', tool: 'HUBSPOT_LIST_CONTACTS', annotations: ['readOnlyHint'], input: { email: 'a@acme.dev' } }])
  // A read the judge asks about becomes a card, like any other call.
  const asked = deps({ judge: async () => 'ask' })
  await callAppTool(asked.deps, call('HUBSPOT_LIST_CONTACTS'))
  assert.equal(asked.calls.some(entry => entry.startsWith('execute:')), false)
})

test('a write the shared judge allows runs directly and leaves a record', async () => {
  const judged: unknown[] = []
  const { deps: d, calls } = deps({ judge: async call => { judged.push(call); return 'allow' } })
  const result = await callAppTool(d, call('HUBSPOT_CREATE_CONTACT'))
  assert.equal((result as { status: string }).status, 'done')
  assert.deepEqual(calls, ['record:HUBSPOT_CREATE_CONTACT', 'execute:HUBSPOT_CREATE_CONTACT:20261030_00', 'end:done'])
  // The judge sees the exact call: tool, its MCP hints and the concrete arguments.
  assert.deepEqual(judged, [{ action: 'hubspot_create_contact', tool: 'HUBSPOT_CREATE_CONTACT', annotations: ['openWorldHint'], input: { email: 'a@acme.dev' } }])
})

test('a call the judge asks for (destructive, unjudged or refused) becomes a card', async () => {
  const { deps: d, calls } = deps({ judge: async () => 'ask' })
  assert.deepEqual(await callAppTool(d, call('HUBSPOT_DELETE_CONTACT')), { status: 'awaiting_approval', actionId: 'card_1' })
  assert.deepEqual(calls, ['card:HUBSPOT_DELETE_CONTACT'])
})

test('explicit settings win over the judgment', async () => {
  const denied = deps({ setting: async () => 'deny' })
  assert.deepEqual(await callAppTool(denied.deps, call('HUBSPOT_CREATE_CONTACT')), { error: 'integrationActionDenied' })
  assert.deepEqual(denied.calls, [])
  const asked = deps({ setting: async () => 'ask' })
  await callAppTool(asked.deps, call('HUBSPOT_CREATE_CONTACT'))
  assert.deepEqual(asked.calls, ['card:HUBSPOT_CREATE_CONTACT'])
  const allowed = deps({ setting: async () => 'allow', judge: async () => 'ask' })
  await callAppTool(allowed.deps, call('HUBSPOT_DELETE_CONTACT'))
  assert.deepEqual(allowed.calls, ['record:HUBSPOT_DELETE_CONTACT', 'execute:HUBSPOT_DELETE_CONTACT:20261030_00', 'end:done'])
})

test('settings: the workspace allow / ask / deny decides, deny beats ask', () => {
  assert.equal(explicitSetting(null, ['x']), null)
  assert.equal(explicitSetting({ workspace: null }, ['x']), null)
  // A workspace Allow is a real grant, not an absence that falls to the judge.
  assert.equal(explicitSetting({ workspace: { hubspot: 'allow' } }, ['hubspot_create_contact', 'hubspot']), 'allow')
  assert.equal(explicitSetting({ workspace: { hubspot: 'ask' } }, ['hubspot_create_contact', 'hubspot']), 'ask')
  assert.equal(explicitSetting({ workspace: { hubspot: 'deny' } }, ['hubspot_create_contact', 'hubspot']), 'deny')
  assert.throws(() => explicitSetting({ workspace: { hubspot: 'maybe' } }, ['hubspot']))
  assert.equal(toolSettingKey('HUBSPOT_CREATE_CONTACT'), 'hubspot_create_contact')
})

test('a workspace Allow on Slack is a real grant: the write runs without the judge', async () => {
  let judged = 0
  const { deps: d, calls } = deps({
    setting: async (tool, toolkit) => appCallSetting({ workspace: { slack: 'allow' } }, tool, toolkit),
    judge: async () => { judged++; return 'ask' },
  })
  const result = await callAppTool(d, call('SLACK_SEND_MESSAGE', 'slack'))
  assert.equal((result as { status?: string }).status, 'done')
  assert.equal(judged, 0, 'the judge runs only when nothing names the app')
  assert.deepEqual(calls, ['record:SLACK_SEND_MESSAGE', 'execute:SLACK_SEND_MESSAGE:1', 'end:done'])
})

test('a workspace deny blocks the call; there is no Bot layer to override it', async () => {
  const workspaceDenies = deps({ setting: async (tool, toolkit) => appCallSetting({ workspace: { slack: 'deny' } }, tool, toolkit) })
  assert.deepEqual(await callAppTool(workspaceDenies.deps, call('SLACK_SEND_MESSAGE', 'slack')), { error: 'integrationActionDenied' })
  const workspaceAllows = deps({ setting: async (tool, toolkit) => appCallSetting({ workspace: { slack: 'allow' } }, tool, toolkit) })
  assert.equal((await callAppTool(workspaceAllows.deps, call('SLACK_SEND_MESSAGE', 'slack')) as { status?: string }).status, 'done')
})

test('with nothing set, the judge still decides', async () => {
  let judged = 0
  const { deps: d } = deps({
    setting: async (tool, toolkit) => appCallSetting(null, tool, toolkit),
    judge: async () => { judged++; return 'ask' },
  })
  assert.deepEqual(await callAppTool(d, call('SLACK_SEND_MESSAGE', 'slack')), { status: 'awaiting_approval', actionId: 'card_1' })
  assert.equal(judged, 1)
})

test('a legacy-only deny (send_slack_message) governs call_app_tool for the same app', async () => {
  const { deps: d, calls } = deps({
    setting: async (tool, toolkit) => appCallSetting({ workspace: { send_slack_message: 'deny' } }, tool, toolkit),
  })
  assert.deepEqual(await callAppTool(d, call('SLACK_SEND_MESSAGE', 'slack')), { error: 'integrationActionDenied' })
  assert.deepEqual(calls, [])
  assert.deepEqual(appCallSettingKeys('slack_send_message', 'slack'), ['slack_send_message', 'slack', 'send_slack_message'])
})

test('an uncertain write stays running and is not resent', async () => {
  const { deps: d, calls } = deps({ execute: async () => { throw new Error('timeout') } })
  assert.deepEqual(await callAppTool(d, call('HUBSPOT_CREATE_CONTACT')), { error: 'operationUncertain', actionId: 'rec_1' })
  assert.deepEqual(calls, ['record:HUBSPOT_CREATE_CONTACT', 'end:running'])
})

test('the call stays inside the person\'s own connected app', async () => {
  assert.deepEqual(await callAppTool(deps({ appAllowed: async () => false }).deps, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationBlockedByWorkspace' })
  assert.deepEqual(await callAppTool(deps({ resolveAccount: async () => ({ accountId: null, accounts: [] }) }).deps, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationNotConnected' })
  const two = [{ id: 'a', alias: null }, { id: 'b', alias: null }]
  assert.deepEqual(await callAppTool(deps({ resolveAccount: async () => ({ accountId: null, accounts: two }) }).deps, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationAccountSelectionRequired', accounts: two })
  // A tool from another app cannot be called through this one's connection.
  assert.deepEqual(await callAppTool(deps().deps, call('SLACK_SEND_MESSAGE')), { error: 'integrationToolNotFound' })
  assert.deepEqual(await callAppTool(deps().deps, call('HUBSPOT_NOPE')), { error: 'integrationToolNotFound' })
  assert.deepEqual(await callAppTool(deps().deps, call('HUBSPOT_UNPINNED')), { error: 'integrationActionVersionUnavailable' })
  // Mikka's own GitHub, Linear and Telegram are not Composio apps here.
  assert.deepEqual(await callAppTool(deps().deps, call('GITHUB_LIST_REPOS', 'github')), { error: 'integrationActionNotAllowed' })
  assert.deepEqual(await callAppTool(deps().deps, { toolkit: 'hubspot', tool: 'bad slug', arguments: {} }), { error: 'invalidIntegrationInput' })
})

test('listing shows only the app\'s own tools and which ones only read', async () => {
  const result = await listAppTools(deps().deps, { toolkit: 'hubspot', query: 'contacts' }) as { tools: { slug: string; readOnly: boolean; input?: unknown }[] }
  assert.deepEqual(result.tools.map(tool => [tool.slug, tool.readOnly]), [['HUBSPOT_LIST_CONTACTS', true], ['HUBSPOT_CREATE_CONTACT', false], ['HUBSPOT_DELETE_CONTACT', false], ['HUBSPOT_UNPINNED', true]])
  assert.deepEqual(result.tools[0].input, { type: 'object' })
  assert.deepEqual(await listAppTools(deps({ resolveAccount: async () => ({ accountId: null, accounts: [] }) }).deps, { toolkit: 'hubspot' }), { error: 'integrationNotConnected' })
})

test('an app that needs no connection runs on the person alone; any other app still needs its account', async () => {
  const hn: AppTool = { slug: 'HACKERNEWS_GET_TOP_STORIES', name: 'Top stories', tags: ['readOnlyHint'], version: '20261030_00', toolkit: { slug: 'hackernews' } }
  const accounts: (string | null)[] = []
  const { deps: d } = deps({
    noAuth: async toolkit => toolkit === 'hackernews',
    resolveAccount: async () => ({ accountId: null, accounts: [] }),
    getTool: async slug => slug === hn.slug ? hn : tools[slug],
    execute: async (_call, accountId) => { accounts.push(accountId); return { successful: true, data: { stories: [] } } },
  })
  assert.deepEqual(await callAppTool(d, { toolkit: 'hackernews', tool: hn.slug, arguments: {} }), { data: { stories: [] } })
  assert.deepEqual(accounts, [null])
  assert.deepEqual(await callAppTool(d, call('HUBSPOT_LIST_CONTACTS')), { error: 'integrationNotConnected' })
  // Still gated by the Bot's app policy.
  assert.deepEqual(await callAppTool({ ...d, appAllowed: async () => false }, { toolkit: 'hackernews', tool: hn.slug, arguments: {} }), { error: 'integrationBlockedByWorkspace' })
})
