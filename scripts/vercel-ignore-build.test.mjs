import assert from 'node:assert/strict'
import test from 'node:test'
import { shouldSkip } from './vercel-ignore-build.mjs'

const a = 'a'.repeat(40)
const b = 'b'.repeat(40)
const env = { VERCEL_ENV: 'production', VERCEL_GIT_PREVIOUS_SHA: a, VERCEL_GIT_COMMIT_SHA: b }
const diff = files => () => ({ files, unsafeModes: false })
const yes = () => true

test('a docs-only change since the last deployment skips the production build', () => {
  assert.equal(shouldSkip(env, diff(['docs/dev-workflow.md', 'CONTRIBUTING.md']), yes).skip, true)
})

test('any code change builds', () => {
  assert.equal(shouldSkip(env, diff(['docs/dev-workflow.md', 'app/page.tsx']), yes).skip, false)
})

test('anything unclear builds', () => {
  assert.equal(shouldSkip({ ...env, VERCEL_GIT_PREVIOUS_SHA: '' }, diff(['README.md']), yes).skip, false)
  assert.equal(shouldSkip({ ...env, VERCEL_GIT_PREVIOUS_SHA: b }, diff(['README.md']), yes).skip, false)
  assert.equal(shouldSkip({ ...env, VERCEL_ENV: 'preview' }, diff(['README.md']), yes).skip, false)
  assert.equal(shouldSkip(env, diff(['README.md']), () => false).skip, false)
  assert.equal(shouldSkip(env, () => { throw new Error('bad range') }, yes).skip, false)
  assert.equal(shouldSkip(env, () => ({ files: ['README.md'], unsafeModes: true }), yes).skip, false)
  assert.equal(shouldSkip(env, diff([]), yes).skip, false)
})
