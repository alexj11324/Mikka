import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createSmokeGitHubFixture, SMOKE_USER_ID, OWNER_USER_ID } from './github-readonly-provider.mjs'
import { createStore } from './github-readonly-store.mjs'
import { check, digest, safeCode, validateState, prepareReadOnlyConnection, cleanupReadOnlyConnection } from './github-readonly-helper.mjs'

export function configuration(args, env) {
  check(env.CI === 'true' && env.GITHUB_REPOSITORY === 'alexj11324/Mikka' && env.GITHUB_RUN_ATTEMPT === '1'
    && env.GITHUB_REF === 'refs/heads/ops/1505-smoke-github-readonly-20261109'
    && env.MIKKA_GITHUB_REPAIR_GO === 'root-reviewed-1505-github-trusted-v4'
    && env.MIKKA_EDITION === 'cloud' && env.NODE_ENV === 'production', 'execution_not_enabled')
  if (args.length === 1 && args[0] === '--prepare') return { operation: 'prepare' }
  check(args.length === 3 && args[0] === '--cleanup' && /^[a-f0-9]{64}$/.test(args[2]), 'arguments_invalid')
  return { operation: 'cleanup', statePath: resolve(args[1]), stateSha256: args[2] }
}

/** The App ID is public provider-verified metadata, never an authority grant.
 * The normal cloud getter reads it at call time; restore the isolated process
 * environment even when the normal repository read fails. */
export async function readRepositoriesForVerifiedApp(read, userId, appId, env = process.env) {
  check(userId === SMOKE_USER_ID && typeof appId === 'string' && /^[1-9]\d{0,19}$/.test(appId), 'verified_app_id_invalid')
  const hadValue = Object.hasOwn(env, 'GITHUB_APP_ID'), original = env.GITHUB_APP_ID
  check(!original?.trim() || original.trim() === appId, 'app_configuration_changed')
  env.GITHUB_APP_ID = appId
  try { return await read(userId) }
  finally { if (hadValue) env.GITHUB_APP_ID = original; else delete env.GITHUB_APP_ID }
}

/** Load only the existing normal application services, after source/GO/argument guards. */
export async function loadRuntime() {
  const [database, connection, access, app, { githubConnections }, { eq, sql }] = await Promise.all([
    import('../../../lib/db/index.ts'), import('../../../lib/github/connection.ts'),
    import('../../../lib/github/user-access.ts'), import('../../../lib/github/app-config.ts'),
    import('../../../lib/db/schema.ts'), import('drizzle-orm'),
  ])
  const close = async () => {
    const { workspacePool } = await import('../../../lib/workspace-db.ts')
    await Promise.allSettled([database.pool.end(), workspacePool.end()])
  }
  try {
  const config = await app.readGitHubAppConfig()
  check(config.clientId && config.clientSecret, 'app_not_configured')
  const deadline = AbortSignal.timeout(5 * 60_000)
  const fetchImpl = (url, init) => fetch(url, { ...init, signal: AbortSignal.any([deadline, init.signal]) })
  return { store: createStore({ pool: database.pool, connection, withDatabaseClient: database.withDatabaseClient,
    withOwnerConnectionLock: callback => database.db.transaction(async tx => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`)
      await tx.execute(sql`SET LOCAL statement_timeout='30s'`)
      return database.withDatabaseTransaction(tx, async () => {
        const [row] = await tx.select({
          userId: githubConnections.userId, githubAccountId: githubConnections.githubAccountId,
          githubLogin: githubConnections.githubLogin, accessTokenExpiresAt: githubConnections.accessTokenExpiresAt,
          updatedAt: githubConnections.updatedAt,
        }).from(githubConnections).where(eq(githubConnections.userId, OWNER_USER_ID)).for('update')
        return callback(row)
      })
    }),
    listRepositoriesForUser: (userId, appId) => readRepositoriesForVerifiedApp(access.listRepositoriesForUser, userId, appId) }),
  provider: createSmokeGitHubFixture({ application: { clientId: config.clientId, clientSecret: config.clientSecret },
    appId: config.id || undefined, fetchImpl }),
  close }
  } catch (error) { await close(); throw error }
}
export async function run(args = process.argv.slice(2), env = process.env, { load = loadRuntime, write = writeReport } = {}) {
  const output = resolve('issue1505-github-readonly-report/receipt.json')
  let runtime, report = { version: 1, issue: 1505, status: 'incomplete', stage: 'configuration' }
  let lastPersisted
  const checkpoint = async value => { await write(output, value); lastPersisted = structuredClone(value) }
  try {
    const selected = configuration(args, env)
    let state
    if (selected.operation === 'cleanup') {
      check(selected.statePath !== output, 'output_overwrites_input')
      const bytes = await readFile(selected.statePath)
      check(digest(bytes) === selected.stateSha256, 'state_bytes_changed')
      const saved = JSON.parse(bytes.toString('utf8'))
      state = validateState(saved.state ?? saved)
    }
    await checkpoint({ ...report, operation: selected.operation })
    runtime = await load()
    report = selected.operation === 'prepare'
      ? await prepareReadOnlyConnection({ ...runtime, checkpoint })
      : await cleanupReadOnlyConnection({ ...runtime, state, checkpoint })
  } catch (error) {
    report = { ...(lastPersisted ?? report), status: 'incomplete', code: safeCode(error),
      ...(lastPersisted?.state ? { commitUnconfirmed: true, changed: null } : {}) }
  } finally {
    try { await runtime?.close() } catch (error) { report = { ...report, status: 'incomplete', closeCode: safeCode(error) } }
    await checkpoint(report)
  }
  return report
}
async function writeReport(path, value) {
  await mkdir(dirname(path), { recursive: true })
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
    console.log(JSON.stringify({ version: 1, issue: 1505, status: 'incomplete', code: safeCode(error), receiptWriteUnconfirmed: true }))
    process.exitCode = 1
  }
}
