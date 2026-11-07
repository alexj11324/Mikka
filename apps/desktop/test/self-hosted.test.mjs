import assert from 'node:assert/strict'
import test from 'node:test'
import { validateSelfHostedDesktopTarget } from './self-hosted.mjs'
const uuid = '10000000-0000-4000-8000-000000000001', revision = 'a'.repeat(40)
const fixture = { origin: 'http://localhost:3000', revision, ownerId: 'disposable', workspaceId: uuid, botId: uuid,
  email: `selfhost-${uuid}@selfhost.example.test`, password: 'b'.repeat(32) }
const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'alexj11324/Mikka', GITHUB_SHA: revision,
  RUNNER_TEMP: '/tmp/runner', GITHUB_WORKSPACE: '/repo', MIKKA_DESKTOP_EXECUTABLE: '/repo/acceptance' }
test('packaged desktop only accepts the exact disposable image and generated identity', () => {
  validateSelfHostedDesktopTarget(fixture, env)
  for (const change of [{ origin: 'https://app.aspectlylabs.com' }, { revision: 'b'.repeat(40) }, { email: 'real@example.com' },
    { botId: 'missing' }, { workspaceId: 'missing' }, { password: '' }]) assert.throws(() => validateSelfHostedDesktopTarget({ ...fixture, ...change }, env))
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_REPOSITORY: 'other/repo' }, { GITHUB_SHA: 'main' },
    { MIKKA_DESKTOP_EXECUTABLE: '' }]) assert.throws(() => validateSelfHostedDesktopTarget(fixture, { ...env, ...change }))
})
