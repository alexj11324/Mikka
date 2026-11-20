import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixtureDatabase, assertFixtureBuild } from './fixtures/guard.mjs'
import { startFixture } from './fixtures/start.mjs'
import { FIXTURE_SCENARIOS } from './fixtures/scenarios.mjs'

export async function prepareFixture({ root = process.cwd(), env = process.env, built = false } = {}) {
  assertFixtureBuild(env)
  const database = fixtureDatabase(env)
  // These commands need only local DB/build settings. Never inherit provider credentials.
  const childEnv = Object.fromEntries(['PATH','LANG','LC_ALL','TMPDIR','SHELL','MIKKA_UI_OVERLAY_DIR','MIKKA_UI_OVERLAY_SHA','MIKKA_BUILD_REVISION','NEXT_PUBLIC_MIKKA_BUILD'].filter(key => env[key]).map(key => [key, env[key]]))
  Object.assign(childEnv, { E2E_DATABASE_URL: database.href, DATABASE_URL: database.href, MIKKA_DATABASE_URL: database.href, MIKKA_LOCAL_TEST_ACCOUNTS: '1' })
  async function run(args) {
    const child = spawn(process.execPath, args, { cwd: root, env: childEnv, stdio: 'inherit' })
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    if (code !== 0) throw new Error(`FIXTURE_COMMAND_FAILED_${code}`)
  }
  if (!built) await run(['scripts/build-application.mjs', '--local-fixture'])
  await run(['--import', 'tsx', 'scripts/setup-e2e-db.mjs'])
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), scene = args.find(value => !value.startsWith('--')) ?? process.env.MIKKA_FIXTURE ?? 'board'
  if (!['all', ...FIXTURE_SCENARIOS].includes(scene) || args.some(value => value !== scene && value !== '--built')) throw new Error('FIXTURE_ARGUMENTS_INVALID')
  await prepareFixture({ built: args.includes('--built') })
  const instance = await startFixture({ scenario: scene })
  console.log(JSON.stringify({ fixture: scene, origin: instance.origin, start: `${instance.origin}/`, target: instance.build.target }))
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void instance.close().then(() => process.exit(0)) })
}
