import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeProgress, ONBOARDING_STEPS, startingProgress } from './onboarding-steps'
import { setupChecklistShown, visibleSetupItems } from './setup-checklist'

test('the guide has Capy\'s four steps in order', () => {
  assert.deepEqual([...ONBOARDING_STEPS], ['workspace', 'model', 'recommended', 'plan'])
})

test('a stored place keeps only steps that exist', () => {
  assert.deepEqual(normalizeProgress({ step: 2, status: { 0: 'done', 1: 'skipped', 4: 'done', x: 'done', 2: 'maybe' } }), { step: 2, status: { 0: 'done', 1: 'skipped' } })
  assert.deepEqual(normalizeProgress({ step: 9 }), { step: 3, status: {} })
  assert.deepEqual(normalizeProgress({ step: -1 }), { step: 0, status: {} })
  assert.deepEqual(normalizeProgress('nonsense'), { step: 0, status: {} })
  assert.deepEqual(normalizeProgress({ step: 1.5 }), { step: 0, status: {} })
})

test('a new person starts at the workspace; someone who joined a team starts at the model', () => {
  assert.deepEqual(startingProgress(null, false), { step: 0, status: {} })
  assert.deepEqual(startingProgress(null, true), { step: 1, status: { 0: 'done' } })
})

test('a saved place wins, except that an invitee never lands on the workspace step', () => {
  assert.deepEqual(startingProgress({ step: 2, status: { 0: 'done', 1: 'skipped' } }, false), { step: 2, status: { 0: 'done', 1: 'skipped' } })
  assert.deepEqual(startingProgress({ step: 0, status: {} }, true), { step: 1, status: { 0: 'done' } })
  assert.deepEqual(startingProgress({ step: 3, status: { 1: 'done' } }, true), { step: 3, status: { 1: 'done' } })
})

test('the setup checklist shows this computer only on desktop and invites only in a team', () => {
  assert.deepEqual(visibleSetupItems({ team: false }, false), ['task', 'model', 'app'])
  assert.deepEqual(visibleSetupItems({ team: true }, true), ['task', 'model', 'device', 'app', 'invite'])
})

test('the setup checklist hides once dismissed or once everything it shows is done', () => {
  assert.equal(setupChecklistShown(undefined, false), false)
  assert.equal(setupChecklistShown({ dismissed: true, team: false, done: {} }, false), false)
  assert.equal(setupChecklistShown({ dismissed: false, team: false, done: { task: true, model: true } }, false), true)
  // A personal workspace on the web shows no device or invite item, so these three finish it.
  assert.equal(setupChecklistShown({ dismissed: false, team: false, done: { task: true, model: true, app: true } }, false), false)
  assert.equal(setupChecklistShown({ dismissed: false, team: false, done: { task: true, model: true, app: true } }, true), true)
})

test('a missing, failed or unexpected checklist read shows nothing instead of crashing 新建任务', () => {
  for (const value of [null, {}, { ok: true }, { dismissed: false }, { dismissed: false, team: false }, { dismissed: false, team: false, done: null }, 'error'])
    assert.equal(setupChecklistShown(value, true), false)
})
