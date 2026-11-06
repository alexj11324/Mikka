import assert from 'node:assert/strict'
import test from 'node:test'
import { runFixtureSetup, ownBotBindingId, reconcileChosenOption } from './coordinator-fixtures.mjs'
import { fakeSession, fixtureReceipt, workspaceReceipt, WORKSPACE_ID, BOT_IDS, OPTION_IDS } from './fixture-support.mjs'

globalThis.fetch = () => { throw new Error('network_forbidden') }

function cloneFixture({ existing = false, invalidCanonical = false } = {}) {
  const base = fakeSession({ readyBots: existing })
  const chosen = new Set(existing ? BOT_IDS : [])
  const canonical = index => invalidCanonical ? '77777777-7777-4777-8777-777777777777'
    : ownBotBindingId(WORKSPACE_ID, BOT_IDS[index], OPTION_IDS[index])
  const provider = (work, options) => base.provider(session => work({ ...session,
    async request(path, input = {}) {
      const action = input.body?.action
      if (action === 'execution-settings.chooseBotModel') chosen.add(input.body.args[0])
      const response = await session.request(path, input)
      if (!['execution-settings.getBotModelMenu', 'execution-settings.chooseBotModel'].includes(action)) return response
      const envelope = await response.json(), menu = envelope.result
      // Both actions return plain BotModelMenu inside the RPC envelope. The
      // chooser's ActionResult<T> is T | { error }, not an extra ok/data wrapper.
      for (const group of menu.groups) for (const option of group.options) {
        const index = OPTION_IDS.indexOf(option.id)
        if (index >= 0 && chosen.has(BOT_IDS[index])) option.id = canonical(index)
      }
      const index = OPTION_IDS.indexOf(menu.current.id)
      if (index >= 0 && chosen.has(BOT_IDS[index])) menu.current.id = canonical(index)
      return Response.json({ ok: true, result: menu })
    } }), options)
  return { base, provider, canonical }
}

test('normal selection of a personal source produces the exact owned-workspace canonical Bot binding', async () => {
  const f = cloneFixture()
  const report = await runFixtureSetup({ env: f.base.options.env, workspaceReceipt: workspaceReceipt(), sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report)); assert.equal(f.base.state.choices, 2)
  assert.deepEqual(report.fixtures.map(row => row.selectedSourceOptionId), OPTION_IDS)
  assert.deepEqual(report.fixtures.map(row => row.optionId), [f.canonical(0), f.canonical(1)])
  assert.equal(report.fixtures.every(row => row.optionCanonicalization === 'exact_owned_bot_binding_clone'), true)
})

test('receipt resume reads an already saved canonical choice without recreating or choosing again', async () => {
  const f = cloneFixture({ existing: true }), receipt = fixtureReceipt()
  receipt.status = 'failed'; receipt.fixtures.forEach(row => { row.status = 'failed'; row.error = 'fixture_model_mismatch' })
  const report = await runFixtureSetup({ env: f.base.options.env, mode: 'resume', receipt, sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'ready', JSON.stringify(report))
  assert.equal(f.base.state.botCreates, 0); assert.equal(f.base.state.choices, 0); assert.equal(f.base.state.sends, 0)
  assert.deepEqual(report.fixtures.map(row => row.optionId), [f.canonical(0), f.canonical(1)])
})

test('an arbitrary listed ID or an unexpected ActionResult wrapper never qualifies as the owned clone', async () => {
  const f = cloneFixture({ existing: true, invalidCanonical: true })
  const report = await runFixtureSetup({ env: f.base.options.env, mode: 'resume', receipt: fixtureReceipt(), sessionProvider: f.provider, checkpoint: false })
  assert.equal(report.status, 'failed'); assert.equal(f.base.state.choices, 0); assert.equal(f.base.state.sends, 0)
  const row = fixtureReceipt().fixtures[0]
  assert.throws(() => reconcileChosenOption({ ok: true, data: { current: { id: row.optionId } } }, row, WORKSPACE_ID), /fixture_model_mismatch/)
})
