import assert from 'node:assert/strict'
import test from 'node:test'
import { withChosenModel, type BotModelMenu } from './bot-model-menu-view'

const menu: BotModelMenu = {
  groups: [
    { kind: 'hosted', options: [{ id: 'hosted', modelId: '', provider: 'mikka' }] },
    { kind: 'subscription', provider: 'claude', plan: 'Max', credentialLabel: 'alex@example.invalid', options: [{ id: 'binding-1', modelId: 'claude-haiku-5-5', provider: 'claude' }] },
  ],
  current: { id: 'hosted', modelId: '', provider: 'mikka', kind: 'hosted', chosen: false, available: true, fallback: 'points' },
}

test('picking a model moves the chip at once: the menu reads as chosen before the server answers', () => {
  const picked = withChosenModel(menu, 'binding-1')
  assert.deepEqual(picked?.current, { id: 'binding-1', modelId: 'claude-haiku-5-5', provider: 'claude', kind: 'subscription', chosen: true, available: true, credentialLabel: 'alex@example.invalid' })
  assert.equal(picked?.groups, menu.groups, 'the list itself is not rebuilt')
  assert.equal(menu.current.id, 'hosted', 'the menu it came from is untouched, so a failed save rolls back to it')
})

test('the guess claims nothing the menu does not know: no fallback or quota is carried over, and an unknown option is no guess', () => {
  assert.equal('fallback' in (withChosenModel(menu, 'binding-1')?.current ?? {}), false)
  assert.equal(withChosenModel(menu, 'hosted')?.current.chosen, true, 'the default picked on purpose is chosen')
  assert.equal(withChosenModel(menu, 'gone'), null)
})
