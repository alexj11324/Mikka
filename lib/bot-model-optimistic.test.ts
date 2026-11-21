import assert from 'node:assert/strict'
import test from 'node:test'
import { previewBotModelChoice } from './bot-model-optimistic'
import type { BotModelMenu } from './bot-model-menu-view'

const menu: BotModelMenu = {
  current: {
    id: 'current', modelId: 'gpt-6-luna', provider: 'codex', kind: 'subscription',
    available: true, availability: 'available', chosen: true,
    fallback: 'quota', credentialLabel: 'previous', quota: {
      subscription: 'codex', plan: 'Pro', resetsAt: null, fallback: null,
    },
  },
  groups: [
    { kind: 'subscription', provider: 'codex', credentialLabel: 'previous',
      options: [{ id: 'current', modelId: 'gpt-6-luna', provider: 'codex' }] },
    { kind: 'shared', owner: 'Member', credentialLabel: 'Shared Claude',
      options: [{ id: 'next', modelId: 'claude-haiku-5-5', provider: 'claude' }] },
  ],
}

test('preview switches the name instantly without asserting remote availability', () => {
  const result = previewBotModelChoice(menu, 'next')
  assert.equal(result?.current.id, 'next')
  assert.equal(result?.current.modelId, 'claude-haiku-5-5')
  assert.equal(result?.current.kind, 'shared')
  assert.equal(result?.current.credentialLabel, 'Shared Claude')
  assert.equal(result?.current.availability, 'checking')
  assert.equal(result?.current.available, false)
  assert.equal(result?.current.chosen, true)
  assert.equal(result?.current.fallback, undefined, 'old-model fallback must not stick to new choice')
  assert.equal(result?.current.quota, undefined, 'old-model quota must not stick to new choice')
  assert.equal(menu.current.id, 'current', 'authoritative SWR data is not mutated')
})

test('a disappeared or unauthorized candidate is never optimistically displayed', () => {
  assert.equal(previewBotModelChoice(menu, 'missing'), null)
  assert.equal(menu.current.id, 'current')
})
