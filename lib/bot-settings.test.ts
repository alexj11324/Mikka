// Bot settings aligned with Capy's Captain (decision 2026-11-19-2105): precedence, alias and legacy repository keys.
import assert from 'node:assert/strict'
import test from 'node:test'
import { botAliasSchema, botSettingsSchema, legacyRepositoryKey, slackBotAlias, withBotDispatchDefaults } from './bot-settings'
import { legacyRepositoryKey as scriptKey } from '../scripts/bot-environment-backfill.mjs'

const device = '6f1d1e7a-1111-4a6b-9c2d-000000000001'
const agent = '6f1d1e7a-1111-4a6b-9c2d-000000000002'
const profile = '6f1d1e7a-1111-4a6b-9c2d-000000000003'

test('a new thread takes the task first, then the Bot, field by field', () => {
  const bot = { crewTarget: { kind: 'device' as const, deviceId: device, agentId: agent }, defaultAgent: 'codex' as const, defaultProfileId: profile }
  assert.deepEqual(withBotDispatchDefaults({}, null), {}, 'no Bot defaults leaves the person\'s own')
  assert.deepEqual(withBotDispatchDefaults({}, { crewTarget: null, defaultAgent: null, defaultProfileId: null }), {})
  // The Bot's device names its Agent, which fixes the harness: the default Agent does not add a second one.
  assert.deepEqual(withBotDispatchDefaults({}, bot), { place: { deviceId: device }, profileId: profile, agentId: agent })
  // A task that names the place keeps it and the Bot's device Agent does not follow.
  assert.deepEqual(withBotDispatchDefaults({ place: 'cloud' }, bot), { place: 'cloud', model: { harness: 'codex' }, profileId: profile })
  assert.deepEqual(withBotDispatchDefaults({ place: 'cloud', model: { harness: 'claude_code' }, profileId: 'mine' }, bot),
    { place: 'cloud', model: { harness: 'claude_code' }, profileId: 'mine' })
  assert.deepEqual(withBotDispatchDefaults({}, { ...bot, crewTarget: { kind: 'cloud', provider: 'cloudflare' } }),
    { place: 'cloud', model: { harness: 'codex' }, profileId: profile, sponsored: true }, 'the Cloudflare coding machine is sponsored')
  assert.deepEqual(withBotDispatchDefaults({ place: 'cloud' }, { ...bot, crewTarget: { kind: 'cloud', provider: 'cloudflare' } }),
    { place: 'cloud', model: { harness: 'codex' }, profileId: profile }, 'a place the task named is never sponsored by the Bot\'s default')
})

test('an alias is 1–32 lowercase characters and Slack finds it as bot=<alias>', () => {
  assert.equal(botAliasSchema.parse('  Release-Bot '), 'release-bot')
  for (const bad of ['', '-x', 'a b', 'x'.repeat(33), 'émoji']) assert.equal(botAliasSchema.safeParse(bad).success, false, bad)
  assert.equal(botAliasSchema.parse('x'.repeat(32)), 'x'.repeat(32))
  assert.equal(slackBotAlias('<@U123> bot=Release_1 please ship'), 'release_1')
  assert.equal(slackBotAlias('bot=reviewer.'), 'reviewer')
  assert.equal(slackBotAlias('robot=reviewer'), null)
  assert.equal(slackBotAlias('no alias here'), null)
  assert.equal(slackBotAlias(undefined), null)
  assert.equal(botSettingsSchema.safeParse({ promote: true }).success, false, 'unknown settings are refused')
})

test('a retired repository becomes an Environment key, the same in the app and the backfill', () => {
  const cases: [string | null, string | null][] = [
    ['Acme/Widgets', 'v2/github.com/acme/widgets'], ['acme/widgets.git', 'v2/github.com/acme/widgets'],
    ['v2/github.com/acme/widgets', 'v2/github.com/acme/widgets'], ['  ', null], [null, null], ['not a repo', null],
    ['v2/github.com/acme/../x', null], ['https://github.com/acme/widgets', null],
  ]
  for (const [input, key] of cases) {
    assert.equal(legacyRepositoryKey(input), key, String(input))
    assert.equal(scriptKey(input), key, `script: ${input}`)
  }
})
