// The actual built app and ephemeral CI database are required for these probes.
import { once } from 'node:events'
import { spawn, spawnSync } from 'node:child_process'
import { validateTarget, parseSummary, checkSummary } from './run-db-tests.mjs'

validateTarget(process.env)
const origin = 'http://localhost:3100'
const probes = [
  ['tests/factory-query-http.test.ts', { FACTORY_QUERY_LOCAL_HTTP: '1', FACTORY_QUERY_HTTP_ORIGIN: origin, FACTORY_QUERY_DATABASE_URL: process.env.E2E_DATABASE_URL }],
  ['tests/factory-question-http.test.ts', { FACTORY_QUESTION_LOCAL_HTTP: '1', FACTORY_QUESTION_HTTP_ORIGIN: origin, FACTORY_QUESTION_DATABASE_URL: process.env.E2E_DATABASE_URL }],
  ['tests/factory-monitor-cycle-http.test.ts', { FACTORY_CYCLE_LOCAL_HTTP: '1', FACTORY_CYCLE_HTTP_ORIGIN: origin, FACTORY_CYCLE_TEST_URL: process.env.E2E_DATABASE_URL }],
]
// These rollout gates belong to this already-validated ephemeral test process.
// The built question endpoints exercise the same enabled consumers as dispatch.
const factoryEnv = { ...process.env, MIKKA_FACTORY_ROUTING_ENABLED: '1', MIKKA_FACTORY_LIFECYCLE_ENABLED: '1' }
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '--port', '3100'], { stdio: 'inherit', env: factoryEnv })
try {
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) throw new Error('Built application exited before readiness')
    try { ready = (await fetch(`${origin}/mikka/sign-in`)).ok } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  if (!ready) throw new Error('Built application did not become ready')
  for (const [file, env] of probes) {
    const result = spawnSync(process.execPath, ['--import', './tests/support/server-only.mjs', '--import', 'tsx', '--test', file], { encoding: 'utf8', env: { ...factoryEnv, ...env }, maxBuffer: 16 << 20 })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    const error = checkSummary(file, result.status, parseSummary(`${result.stdout}\n${result.stderr}`))
    if (error) throw new Error(error)
  }
} finally {
  if (server.exitCode === null) {
    const closed = once(server, 'close')
    server.kill('SIGTERM')
    await closed
  }
}
