import { spawnSync } from 'node:child_process'
import { assertFixtureBuild } from './fixtures/guard.mjs'
import { assertNoFixtureAuthInOutput } from './fixtures/bundle-check.mjs'

const flags = process.argv.slice(2)
if (flags.length > 1 || flags.some(flag => !['--server-pages', '--public-test-fixture', '--local-fixture'].includes(flag))) {
  throw new Error('APPLICATION_BUILD_ARGUMENTS_INVALID')
}
const applicationEnv = { ...process.env }
const fixture = flags.includes('--local-fixture')
if (fixture) assertFixtureBuild(applicationEnv)
else if (applicationEnv.MIKKA_FIXTURE) throw new Error('FIXTURE_RELEASE_BUILD_FORBIDDEN')
applicationEnv.MIKKA_BUILD_TARGET = fixture ? 'local-fixture' : 'production'
const frontendFlags = fixture ? applicationEnv.MIKKA_UI_OVERLAY_DIR ? [] : ['--public-test-fixture'] : flags
delete applicationEnv.WORKFLOW_TARGET_WORLD
for (const [script, ...args] of [
  ['scripts/build-eve.mjs'],
  ['apps/frontend/scripts/build.mjs', ...frontendFlags],
  ['apps/api/scripts/build.mjs'],
  ['scripts/package-eve.mjs'],
]) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit', env: script === 'scripts/build-eve.mjs' ? process.env : applicationEnv })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
await assertNoFixtureAuthInOutput(process.cwd())
