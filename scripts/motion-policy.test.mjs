import assert from 'node:assert/strict'
import test from 'node:test'
import { auditMotion } from './motion-policy.mjs'

const audit = code => auditMotion('components/example.tsx', code)

test('a raw duration fails and names the token that replaces it', () => {
  const [problem] = audit('<div className="transition-opacity duration-150" />')
  assert.equal(problem.rule, 'motion/raw-duration')
  assert.match(problem.message, /--motion-fast/)
  assert.match(audit('<div className="duration-200" />')[0].message, /--motion-base/)
  assert.match(audit('<div className="duration-300" />')[0].message, /--motion-slow/)
})

test('the token form passes', () => {
  for (const token of ['--motion-fast', '--motion-base', '--motion-slow']) {
    assert.deepEqual(audit(`<div className="transition-opacity duration-(${token})" />`), [])
  }
})

test('duration-0 is not motion: a swipe that follows the finger stays instant', () => {
  assert.deepEqual(audit('<div className="data-swiping:duration-0" />'), [])
})

test('an arbitrary duration fails too', () => {
  assert.equal(audit('<div className="duration-[0.35s]" />').length, 1)
})

test('motion-exempt with a reason, on the line or the two above it', () => {
  assert.deepEqual(audit('{/* motion-exempt: the drawer tracks the finger */}\n<div className="duration-450" />'), [])
  assert.deepEqual(audit('<div className="duration-450" /> {/* motion-exempt: follows the finger */}'), [])
})

test('an exempt comment needs a reason', () => {
  assert.equal(audit('{/* motion-exempt: */}\n<div className="duration-450" />').length, 1)
})

test('the vendored component roots are exempt, read from ui-policy.json', () => {
  for (const file of ['components/ui/x.tsx', 'components/reui/y.tsx', 'components/blocks/z.tsx', 'components/motion/m.tsx', 'components/agents/a.tsx', 'components/ai-elements/e.tsx']) {
    assert.deepEqual(auditMotion(file, '<div className="duration-300" />'), [], file)
  }
  assert.equal(auditMotion('components/settings/x.tsx', '<div className="duration-300" />').length, 1)
})

test('an instant duration passes in both spellings', () => {
  assert.deepEqual(audit('<div className="duration-0" />'), [])
  assert.deepEqual(audit('<div className="duration-[0ms]" />'), [])
  assert.deepEqual(audit('<div className="duration-[0s]" />'), [])
})

test('a comment that names a duration explains it; it does not set one', () => {
  assert.deepEqual(audit('/** matches `duration-150` on the card */\nconst MS = 150'), [])
  assert.deepEqual(audit('// duration-200 here is deliberate\nconst x = 1'), [])
})
