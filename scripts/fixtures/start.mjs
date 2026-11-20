import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:net'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import pg from 'pg'
import { startExternalServices } from '../../tests/fakes/external-services.mjs'
import { githubFixture } from '../../tests/fakes/github-fixture.mjs'
import { startFakeLiteLlm, FAKE_LITELLM_KEY } from '../../tests/fakes/litellm.mjs'
import { localModelAnswer, localDecision } from '../dev-local/model.mjs'
import { grantLocalCredits } from '../dev-local/services.mjs'
import { assertFixtureRuntime } from './guard.mjs'
import { readCompiledBuild } from '../start-app.mjs'
import { seedFixture } from './seed.mjs'
import { FIXTURE_SCENARIOS, fixtureScenario } from './scenarios.mjs'
import { startFixtureProxy, fixtureUpstreamRequest } from './proxy.mjs'

export async function availableFixturePort() {
  const socket = createServer()
  await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve) })
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}

/** Only explicit non-release manifests reach this script; the product has no fixture login route. */
export async function startFixture({ root = process.cwd(), env = process.env, scenario = env.MIKKA_FIXTURE ?? 'board', origin } = {}) {
  const names = scenario === 'all' ? FIXTURE_SCENARIOS : [fixtureScenario(scenario).name]
  origin ??= `http://127.0.0.1:${env.MIKKA_FIXTURE_PORT ?? await availableFixturePort()}`
  const built = await readCompiledBuild(root, { env })
  const { database } = assertFixtureRuntime({ env, built, origin })
  const authSecret = randomBytes(32).toString('base64url'), sealKey = randomBytes(32).toString('hex')
  const runtimeEnv = { ...env, E2E_DATABASE_URL: database.href, MIKKA_DATABASE_URL: database.href, DATABASE_URL: database.href,
    BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: authSecret, WORKSPACE_SECRETS_KEY: sealKey, MIKKA_LOCAL_TEST_ACCOUNTS: '1' }
  const pool = new pg.Pool({ connectionString: database.href, max: 2, statement_timeout: 15_000 })
  const fixtures = new Map(), closers = [() => pool.end()]
  let app, failure, stopping = false
  const close = async () => { if (stopping) return; stopping = true; for (const closer of closers.reverse()) await closer() }
  try {
    for (const name of names) fixtures.set(name, await seedFixture(pool, name, runtimeEnv))
    await grantLocalCredits(pool)
    const external = await startExternalServices(); closers.push(() => external.close())
    const github = await githubFixture({ githubAccountId: 4242 }); closers.push(() => github.close())
    const models = await startFakeLiteLlm({ answer: localModelAnswer, decision: localDecision }); closers.push(() => models.close())
    const upstream = `http://127.0.0.1:${await availableFixturePort()}`
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    // Explicit allow-list: no inherited provider keys, real auth cookie, or proxy can reach this child.
    const childEnv = Object.fromEntries(['PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'SHELL'].filter(key => env[key]).map(key => [key, env[key]]))
    Object.assign(childEnv, { NODE_ENV: 'production', E2E_DATABASE_URL: database.href, MIKKA_DATABASE_URL: database.href, DATABASE_URL: database.href,
      BETTER_AUTH_URL: origin, BETTER_AUTH_SECRET: authSecret, WORKSPACE_SECRETS_KEY: sealKey, MIKKA_LOCAL_TEST_ACCOUNTS: '1',
      MIKKA_FIXTURE_ORIGIN: origin, MIKKA_FIXTURE_SERVICES: external.origin, MIKKA_FIXTURE_GITHUB: github.origin,
      MIKKA_LITELLM_URL: models.url, MIKKA_LITELLM_MASTER_KEY: FAKE_LITELLM_KEY,
      E2B_API_URL: external.e2bOptions.apiUrl, E2B_SANDBOX_URL: external.e2bOptions.sandboxUrl, E2B_HTTP_VERSION: '1.1',
      GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      NODE_OPTIONS: `--import ${pathToFileURL(resolve(root, 'scripts/fixtures/preload.mjs')).href}`,
      NITRO_HOST: '127.0.0.1', NITRO_PORT: new URL(upstream).port,
    })
    app = spawn(process.execPath, ['.output/server/mikka-entry.mjs'], { cwd: root, env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] })
    // Never forward raw stderr: database and HTTP exceptions can include secrets.
    app.stderr.resume()
    app.once('error', () => { failure = new Error('FIXTURE_APPLICATION_START_FAILED') })
    app.once('exit', code => { if (!stopping) failure = new Error(`FIXTURE_APPLICATION_EXITED_${code}`) })
    closers.push(async () => {
      if (app.exitCode !== null) return
      app.kill('SIGTERM')
      await new Promise(resolve => { const timer = setTimeout(() => { app.kill('SIGKILL'); resolve() }, 10_000); app.once('exit', () => { clearTimeout(timer); resolve() }) })
    })
    const deadline = Date.now() + 60_000
    let ready = false
    while (Date.now() < deadline) {
      if (failure) throw failure
      try { const response = await fixtureUpstreamRequest(upstream, '/mikka/api/version', { origin }); ready = response.ok; await response.body?.cancel() } catch { /* owned server is starting */ }
      if (ready) break
      await delay(100)
    }
    assert.ok(ready, 'FIXTURE_APPLICATION_NOT_READY')
    const proxy = await startFixtureProxy({ origin, upstream, fixtures, defaultScene: names[0] }); closers.push(() => proxy.close())
    return { origin, scenes: names, build: built, close, assertHealthy() { if (failure) throw failure } }
  } catch (error) { await close(); throw error }
}
