import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createSmokeGitHubFixture, SMOKE_USER_ID, OWNER_USER_ID } from './github-write-provider.mjs'
import { createStore } from './github-write-store.mjs'
import { check, safeCode, prepareWriteConnection, cleanupWriteConnection } from './github-write-helper.mjs'
import { BINDING, BRANCH, checkBinding, guardSource, guardMain, cleanupEvidence } from './github-write-guard.mjs'

export function configuration(args, env) {
  check(env.CI === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_RUN_ATTEMPT === '1'
    && env.GITHUB_REF === 'refs/heads/' + BRANCH
    && env.MIKKA_GITHUB_REPAIR_GO === 'root-reviewed-1782-github-write-child-v1'
    && env.MIKKA_EDITION === 'cloud' && env.NODE_ENV === 'production', 'execution_not_enabled')
  check(args.length === 1 && ['--prepare', '--cleanup'].includes(args[0]), 'arguments_invalid')
  return { operation: args[0].slice(2) }
}

/** The normal cloud getter receives only provider-verified public App metadata. */
export async function readRepositoriesForVerifiedApp(read, userId, appId, env = process.env) {
  check(userId === SMOKE_USER_ID && typeof appId === 'string' && /^[1-9]\d{0,19}$/.test(appId), 'verified_app_id_invalid')
  const hadValue = Object.hasOwn(env, 'GITHUB_APP_ID'), original = env.GITHUB_APP_ID
  check(!original?.trim() || original.trim() === appId, 'app_configuration_changed')
  env.GITHUB_APP_ID = appId
  try { return await read(userId) }
  finally { if (hadValue) env.GITHUB_APP_ID = original; else delete env.GITHUB_APP_ID }
}

/** The independent cleanup clock starts on first cleanup use. A failed setup's
 * exact known-child revocation is not blocked by its expired work/window clock. */
export function createBudget({ now = Date.now, workMs = 300000, cleanupMs = 120000 } = {}) {
  check(Number.isSafeInteger(workMs) && workMs > 0 && workMs <= 300000
    && Number.isSafeInteger(cleanupMs) && cleanupMs > 0 && cleanupMs <= 120000, 'arguments_invalid')
  const work = new AbortController(), cleanup = new AbortController(), end = now() + workMs
  const error = () => new Error('issue1782_github_budget_exhausted')
  const workTimer = setTimeout(() => work.abort(error()), workMs)
  let cleanupTimer, cleanupEnd
  const cleanupSignal = () => {
    if (cleanupEnd === undefined) { cleanupEnd = now() + cleanupMs; cleanupTimer = setTimeout(() => cleanup.abort(error()), cleanupMs) }
    if (now() >= cleanupEnd) cleanup.abort(error())
    return cleanup.signal
  }
  const assertWork = () => { if (now() >= end) work.abort(error()); work.signal.throwIfAborted() }
  return { signal: work.signal, assertWork, cleanupSignal,
    signalFor(stage) { return ['revoke_scoped_token', 'check_revoked_token'].includes(stage) ? cleanupSignal() : (assertWork(), work.signal) },
    dispose() { clearTimeout(workTimer); clearTimeout(cleanupTimer) } }
}

export async function closeRuntime(runtime, timeoutMs = 30000) {
  if (!runtime) return
  let timer
  try {
    await Promise.race([Promise.resolve().then(() => runtime.close()), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('issue1782_github_budget_exhausted')), timeoutMs)
    })])
  } finally { clearTimeout(timer) }
}

/** Import the separately source-verified current application, never the old
 * product files carried by the owned Ops branch. Values remain in memory. */
export async function loadRuntime({ application, budget }) {
  const module = path => import(pathToFileURL(resolve(application, path)).href)
  const require = createRequire(resolve(application, 'package.json'))
  const [database, connection, access, app, { githubConnections }, { eq, sql }] = await Promise.all([
    module('lib/db/index.ts'), module('lib/github/connection.ts'), module('lib/github/user-access.ts'),
    module('lib/github/app-config.ts'), module('lib/db/schema.ts'), import(pathToFileURL(require.resolve('drizzle-orm')).href),
  ])
  const close = async () => {
    const { workspacePool } = await module('lib/workspace-db.ts')
    const results = await Promise.allSettled([database.pool.end(), workspacePool.end()])
    const failed = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (failed.length) throw new AggregateError(failed, 'issue1782_github_dependency_failed')
  }
  try {
    budget.assertWork()
    const config = await app.readGitHubAppConfig()
    check(config.clientId && config.clientSecret, 'app_not_configured')
    return { store: createStore({ pool: database.pool, connection, withDatabaseClient: database.withDatabaseClient,
      withOwnerConnectionLock: callback => database.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
        await tx.execute(sql`SET LOCAL statement_timeout='30s'`)
        return database.withDatabaseTransaction(tx, async () => {
          const [row] = await tx.select({ userId: githubConnections.userId, githubAccountId: githubConnections.githubAccountId,
            githubLogin: githubConnections.githubLogin, accessTokenExpiresAt: githubConnections.accessTokenExpiresAt,
            updatedAt: githubConnections.updatedAt }).from(githubConnections)
            .where(eq(githubConnections.userId, OWNER_USER_ID)).for('update')
          return callback(row)
        })
      }),
      listRepositoriesForUser: (userId, appId) => readRepositoriesForVerifiedApp(access.listRepositoriesForUser, userId, appId) }),
    provider: createSmokeGitHubFixture({ application: { clientId: config.clientId, clientSecret: config.clientSecret },
      appId: config.id || undefined, signalFor: budget.signalFor }), close }
  } catch (error) {
    try { await closeRuntime({ close }) } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'issue1782_github_dependency_failed', { cause: error }) }
    throw error
  }
}

export async function run(args = process.argv.slice(2), env = process.env,
  { load = loadRuntime, write = writeReport, binding = BINDING, sourceGuard = guardSource,
    mainGuard = guardMain, evidence = cleanupEvidence, fetchImpl = fetch, now = Date.now } = {}) {
  const output = resolve(env.RUNNER_TEMP ?? '.', 'issue1782-github-write-report/receipt.json')
  let runtime, budget, source, report = { version: 1, issue: 1782, status: 'incomplete', stage: 'configuration' }, lastPersisted
  const checkpoint = async value => {
    const saved = { ...value, ...(source ? { source } : {}) }
    await write(output, saved); lastPersisted = structuredClone(saved)
  }
  try {
    const selected = configuration(args, env)
    checkBinding(binding); check(binding.operation === selected.operation, 'arguments_invalid')
    const locations = await sourceGuard(env, binding)
    source = { applicationSha: binding.applicationSha, applicationTree: binding.applicationTree,
      opsSource: env.GITHUB_SHA, runId: env.GITHUB_RUN_ID, runAttempt: env.GITHUB_RUN_ATTEMPT }
    report = { ...report, operation: selected.operation, stage: 'source_verified' }
    await checkpoint(report)
    budget = createBudget({ now })
    const entry = () => mainGuard(env, binding, fetchImpl, now, 8 * 60000, budget.signal)
    await entry()
    const recovered = selected.operation === 'cleanup' ? await evidence(env, binding, fetchImpl, budget.signal) : undefined
    await entry()
    budget.assertWork()
    runtime = await load({ ...locations, budget })
    const guard = () => mainGuard(env, binding, fetchImpl, now, 0, budget.signal)
    report = selected.operation === 'prepare'
      ? await prepareWriteConnection({ ...runtime, checkpoint, now, guard, beforeCommit: budget.assertWork })
      : await cleanupWriteConnection({ ...runtime, state: recovered.state, checkpoint, now })
  } catch (error) {
    report = { ...(lastPersisted ?? report), status: 'incomplete', code: safeCode(error),
      ...(lastPersisted?.state ? { commitUnconfirmed: true, changed: null } : {}) }
  } finally {
    try { await closeRuntime(runtime) } catch (error) { report = { ...report, status: 'incomplete', closeCode: safeCode(error) } }
    budget?.dispose()
    await checkpoint(report)
  }
  return { ...report, ...(source ? { source } : {}) }
}
async function writeReport(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.tmp'
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  await rename(temporary, path)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await run()
    console.log(JSON.stringify(report))
    if (report.status !== 'passed') process.exitCode = 1
  } catch (error) {
    console.log(JSON.stringify({ version: 1, issue: 1782, status: 'incomplete', code: safeCode(error), receiptWriteUnconfirmed: true }))
    process.exitCode = 1
  }
}
