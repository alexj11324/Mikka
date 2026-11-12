import { spawnSync } from 'node:child_process'

const flags = process.argv.slice(2)
if (flags.length > 1 || flags.some(flag => !['--server-pages', '--public-test-fixture'].includes(flag))) {
  throw new Error('APPLICATION_BUILD_ARGUMENTS_INVALID')
}
for (const [script, ...args] of [
  ['scripts/build-eve.mjs'],
  ['apps/frontend/scripts/build.mjs', ...flags],
  ['apps/api/scripts/build.mjs'],
  ['scripts/package-eve.mjs'],
]) {
  const result = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
