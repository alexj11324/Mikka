import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer, IncomingMessage } from 'node:http'
import { registerHooks } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { apiAliases } from '../../apps/api/compat-aliases.mjs'
import type { ApiRoute } from '../../apps/api/src/routes'
import { daemonStatusSchema, runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { runWorktreeIdentity } from '@mikka/protocol/coding-workspace'
import { orderMigrations } from '../../scripts/migration-order.mjs'
import { disposableDatabase, E2E_DB_RULE } from '../../tests/helpers/e2e-target.mjs'
import { dropTestDatabase } from '../../tests/support/drop-test-database'

const databaseURL = process.env.E2E_DATABASE_URL
if (databaseURL) assert.ok(disposableDatabase(process.env, databaseURL), E2E_DB_RULE)
else if (process.env.REQUIRE_DB === '1') assert.fail('REQUIRE_DB=1 needs an isolated E2E_DATABASE_URL')
const execute = promisify(execFile)
type FixtureDaemon = { stop(): Promise<void>; syncWithServer(): Promise<void>; status(): unknown }

function fixtureDaemon(value: unknown): FixtureDaemon {
  assert.ok(value && typeof value === 'object')
  for (const method of ['stop', 'syncWithServer', 'status'])
    assert.equal(typeof (value as Record<string, unknown>)[method], 'function', `real daemon implements ${method}`)
  return value as FixtureDaemon
}

/** This is the complete local Files transport: a real listening HTTP API,
 * real session/PAT/device authentication, PostgreSQL LISTEN, the full daemon,
 * its on-disk RunJournal, and the daemon's default HttpServerLink fetch.
 * No mock transport, direct readWorkspace invocation, browser or model call. */
test('Files HTTP API → commands → full daemon → receipt → HTTP response on PostgreSQL 17', { skip: !databaseURL, timeout: 180_000 }, async t => {
  const admin = new Pool({ connectionString: databaseURL, max: 1, connectionTimeoutMillis: 5000 })
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'HTTP/daemon acceptance requires PostgreSQL 17')
  const database = `workspace_http_${randomUUID().replaceAll('-', '')}_e2e`
  await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`)
  const target = new URL(databaseURL!); target.pathname = `/${database}`
  const pool = new Pool({ connectionString: target.toString(), max: 8, connectionTimeoutMillis: 5000 })
  const root = await mkdtemp(join(tmpdir(), 'mikka-files-http-'))
  const environment: Record<string, string | undefined> = {
    MIKKA_DATABASE_URL: target.toString(), DATABASE_URL: target.toString(), ORVILO_DATABASE_URL: target.toString(), E2E_DATABASE_URL: target.toString(),
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), BETTER_AUTH_URL: undefined,
    WORKSPACE_SECRETS_KEY: randomBytes(32).toString('hex'), MIKKA_BASE_PATH: '/mikka', MIKKA_EDITION: 'community',
    MIKKA_TEST_MODE: '1', NODE_ENV: 'test', VERCEL_ENV: undefined, VERCEL: undefined,
    DEVICE_GATEWAY_URL: undefined, DEVICE_GATEWAY_PUSH_SECRET: undefined, MIKKA_TRACE_SAMPLE_RATE: '0',
  }
  const previous = Object.fromEntries(Object.keys(environment).map(name => [name, process.env[name]]))
  for (const [name, value] of Object.entries(environment)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
  // Use the same request-scoped adapters as the independent production API.
  // This is module resolution, not a mock of headers, cookies or authentication.
  const aliases = apiAliases as Record<string, string>
  const loader = registerHooks({ resolve(specifier, context, next) {
    const mapped = specifier === '@' ? undefined : aliases[specifier]
    return next(mapped ? pathToFileURL(mapped).href : specifier, context)
  } })
  let daemon: FixtureDaemon | undefined, appPool: Pool | undefined, workspacePool: Pool | undefined
  let closeHTTP: (() => Promise<void>) | undefined
  const traffic: Array<{ method: string; path: string; status: number }> = []
  const deliveries: Array<{ id: string; runId: string; repoId: string }> = []
  const receipts: Array<{ requestId: string; status: number }> = []
  const firstReceipt = Promise.withResolvers<void>()
  try {
    const migrations = new URL('../../drizzle/', import.meta.url)
    for (const name of orderMigrations((await readdir(migrations)).filter(name => name.endsWith('.sql'))))
      await pool.query(await readFile(new URL(name, migrations), 'utf8'))
    const { createApiHandler } = await import('../../apps/api/src/application')
    const { serve } = await import('srvx/node')
    const route = (template: string, methods: string[], load: ApiRoute['load']): ApiRoute => ({ path: `/mikka${template}`, template, source: `app${template}/route.ts`, methods, load })
    const routes: ApiRoute[] = [
      route('/v1/devices/register', ['POST'], () => import('../../app/v1/devices/register/route')),
      route('/v1/devices/[deviceId]/heartbeat', ['POST'], () => import('../../app/v1/devices/[deviceId]/heartbeat/route')),
      route('/v1/devices/[deviceId]/repos', ['GET'], () => import('../../app/v1/devices/[deviceId]/repos/route')),
      route('/v1/devices/[deviceId]/runs', ['GET'], () => import('../../app/v1/devices/[deviceId]/runs/route')),
      route('/v1/devices/[deviceId]/gateway', ['GET'], () => import('../../app/v1/devices/[deviceId]/gateway/route')),
      route('/v1/devices/[deviceId]/commands', ['GET'], () => import('../../app/v1/devices/[deviceId]/commands/route')),
      route('/v1/devices/[deviceId]/workspace/requests/[requestId]', ['POST'], () => import('../../app/v1/devices/[deviceId]/workspace/requests/[requestId]/route')),
      route('/api/runs/[runId]/workspace/identity', ['GET'], () => import('../../app/api/runs/[runId]/workspace/identity/route')),
      route('/api/runs/[runId]/workspace/files', ['GET'], () => import('../../app/api/runs/[runId]/workspace/files/route')),
      route('/api/runs/[runId]/workspace/mentions', ['POST'], () => import('../../app/api/runs/[runId]/workspace/mentions/route')),
    ]
    const application = createApiHandler(routes)
    const runtime = serve({ manual: true, gracefulShutdown: false, silent: true, trustProxy: false, hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        assert.ok(request.runtime?.node?.req instanceof IncomingMessage, 'requests enter through a TCP socket and srvx NodeRequest')
        const path = new URL(request.url).pathname
        const response = await application.fetch(request)
        traffic.push({ method: request.method, path, status: response.status })
        if (path.endsWith('/commands') && response.status === 200) {
          const body = await response.clone().json()
          for (const command of body.workspaceRequests ?? []) deliveries.push({ id: command.id, runId: command.identity.runId, repoId: command.identity.repoId })
        }
        if (request.method === 'POST' && path.includes('/workspace/requests/')) {
          receipts.push({ requestId: path.split('/').at(-1)!, status: response.status })
          if (response.status === 204) firstReceipt.resolve()
        }
        return response
      },
    })
    const server = createServer(runtime.node!.handler)
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    closeHTTP = async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await runtime.close()
    }
    process.env.BETTER_AUTH_URL = origin

    const owner = `http-files-owner-${randomUUID()}`, member = `http-files-member-${randomUUID()}`
    for (const user of [owner, member]) await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,now(),now())', [user, `${user}@example.invalid`])
    const workspaceId = randomUUID(), otherWorkspace = randomUUID(), teamId = randomUUID(), issueId = randomUUID()
    for (const id of [workspaceId, otherWorkspace]) {
      await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'HTTP Files fixture\')', [id, owner])
      for (const user of [owner, member]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [id, user, `${user}@example.invalid`])
    }
    await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'HTTP Files fixture\',\'HTTPFILES\')', [teamId, workspaceId, owner])
    await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner])
    await pool.query(`INSERT INTO issues(id,"userId",title,content,status,priority,scope) VALUES($1,$2,'HTTP Files fixture','{"type":"doc","content":[]}','done','normal','workspace')`, [issueId, owner])
    await pool.query('INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId") VALUES($1,$2,$3,$4)', [issueId, teamId, workspaceId, owner])
    const runId = randomUUID(), repoId = randomUUID(), deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
    const dataDir = join(root, 'daemon'), worktree = join(dataDir, 'worktrees', runId)
    const remote = `https://github.com/mikka-http-fixtures/${runId}.git`, repositoryKey = remoteKey(remote)
    const source = 'export const answer = 42\nexport const transport = "real HTTP and daemon"\n'
    await mkdir(join(worktree, 'src'), { recursive: true })
    await writeFile(join(worktree, 'src/example.ts'), source)
    await writeFile(join(worktree, '.env'), 'SYNTHETIC_PRIVATE=value\n')
    await writeFile(join(worktree, '.gitignore'), '.env\n')
    await execute('git', ['init', '--initial-branch=main', worktree])
    await execute('git', ['-C', worktree, 'remote', 'add', 'origin', remote])
    await execute('git', ['-C', worktree, 'add', '.'])
    await execute('git', ['-C', worktree, '-c', 'user.name=Mikka fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', 'HTTP Files fixture'])
    const headSha = (await execute('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim()
    const { newDeviceToken, hashDeviceToken } = await import('../device-link')
    const credential = newDeviceToken()
    await pool.query('INSERT INTO devices(id,"ownerId",name,kind,enabled,harnesses) VALUES($1,$2,\'HTTP Files daemon\',\'local\',true,\'[]\')', [deviceId, owner])
    await pool.query('INSERT INTO agents(id,"userId",name,harness,"deviceId") VALUES($1,$2,\'HTTP Files fixture\',\'codex\',$3)', [agentId, owner, deviceId])
    await pool.query('INSERT INTO device_repos(id,"userId","deviceId","repoPath","remoteUrl") VALUES($1,$2,$3,$4,$5)', [repoId, owner, deviceId, repositoryKey, remote])
    // Local devices use ordinary credentials. Bound tokens are exclusively
    // cloud-machine credentials and would correctly fail real local HTTP auth.
    await pool.query('INSERT INTO device_tokens(id,"userId","tokenHash") VALUES($1,$2,$3)', [tokenId, owner, hashDeviceToken(credential)])
    await pool.query(`INSERT INTO agent_runs(id,"userId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","finishedAt","agentDefinition")
      VALUES($1,$2,$3,$4,$5,$6,$7,'succeeded',$8,now(),$9)`, [runId, owner, issueId, agentId, deviceId, repoId, tokenId, worktree,
      { executionIdentity: { workspaceId }, repositoryAdmission: { workspaceId, remoteKey: repositoryKey } }])
    const { RunJournal } = await import('../../packages/daemon/src/runs/journal')
    const { daemonPaths } = await import('../../packages/daemon/src/paths')
    const paths = daemonPaths(dataDir)
    await writeFile(paths.device, JSON.stringify({ credential, deviceId, workspaceId }), { mode: 0o600 })
    new RunJournal(paths.journal).put({
      assignment: runAssignmentSchema.parse({ runId, issueId, repoId, deviceId, remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Retained source fixture', kind: 'implement' }),
      state: 'succeeded', sessionId: null, worktree, baseCommit: headSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString(),
    })
    const { auth } = await import('../auth')
    const { createPersonalAccessToken } = await import('../tokens/store')
    const ownerToken = await createPersonalAccessToken(owner, workspaceId, { name: 'HTTP Files owner' })
    const memberToken = await createPersonalAccessToken(member, workspaceId, { name: 'HTTP Files member' })
    const otherToken = await createPersonalAccessToken(owner, otherWorkspace, { name: 'HTTP Files other workspace' })
    const session = await (await auth.$context).internalAdapter.createSession(owner)
    assert.ok(session)
    appPool = (await import('../db')).pool; workspacePool = (await import('../workspace-db')).workspacePool
    // The daemon has its own strict TypeScript program. Keep execution real
    // without compiling its CLI/adapters under Next's global ProcessEnv types.
    const linkModule: Record<string, unknown> = await import(new URL('../../packages/daemon/src/server-link-http.ts', import.meta.url).href)
    const mainModule: Record<string, unknown> = await import(new URL('../../packages/daemon/src/main.ts', import.meta.url).href)
    assert.equal(typeof linkModule.HttpServerLink, 'function')
    assert.equal(typeof mainModule.startDaemon, 'function')
    const link: unknown = Reflect.construct(linkModule.HttpServerLink as Function, [`${origin}/mikka`])
    assert.ok(link && typeof link === 'object' && 'fetchCommands' in link && typeof link.fetchCommands === 'function')
    daemon = fixtureDaemon(await Reflect.apply(mainModule.startDaemon as Function, undefined, [{ dataDir, flavor: 'dev', link, credential,
      harnesses: [], modelProbe: false, agentSandbox: null, quotaSource: null, retainResources: true, heartbeatMs: 60_000, commandsWaitSeconds: 25 }]))
    await daemon.syncWithServer()
    const status = daemonStatusSchema.parse(daemon.status())
    assert.equal(status.server, 'online', JSON.stringify(traffic))
    assert.equal(status.deviceId, deviceId)
    assert.deepEqual(status.harnesses, [])
    assert.equal(new RunJournal(paths.journal).get(runId)?.state, 'succeeded')
    const endpoint = `${origin}/mikka/api/runs/${runId}/workspace`
    const getIdentity = (token?: string, selectedWorkspace = workspaceId) => fetch(`${endpoint}/identity?${new URLSearchParams({ workspaceId: selectedWorkspace })}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000),
    })
    // A real client knows its Run, not the task VM's database repo binding.
    // Discover that binding through the authenticated API before Files/Mentions.
    const discovery = await getIdentity(ownerToken.token)
    assert.equal(discovery.status, 200, JSON.stringify(traffic))
    assert.equal(discovery.headers.get('cache-control'), 'private, no-store')
    const discovered = await discovery.json()
    assert.equal(discovered.ok, true)
    const clientIdentity = runWorktreeIdentity.parse(discovered.identity)
    assert.equal(clientIdentity.runId, runId); assert.equal(clientIdentity.repoId, repoId)
    assert.equal(clientIdentity.workspaceId, workspaceId); assert.equal(clientIdentity.deviceId, deviceId)
    const fileURL = (path = 'src/example.ts') => `${endpoint}/files?${new URLSearchParams({ workspaceId, repoId: clientIdentity.repoId, kind: 'file', path })}`
    const getFile = (token?: string, path?: string) => fetch(fileURL(path), { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000) })
    const mention = (input: Record<string, unknown>, token = ownerToken.token) => fetch(`${endpoint}/mentions`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' }, body: JSON.stringify({ workspaceId, repoId: clientIdentity.repoId, ...input }), signal: AbortSignal.timeout(20_000) })

    await t.test('identity discovery and Files auth refusals reach no daemon source request', async () => {
      const before = deliveries.length
      assert.equal((await getIdentity()).status, 401)
      assert.equal((await getIdentity(memberToken.token)).status, 404)
      assert.equal((await getIdentity(otherToken.token)).status, 404)
      assert.equal((await getIdentity(ownerToken.token, otherWorkspace)).status, 404)
      assert.equal((await getFile()).status, 401)
      assert.equal((await getFile(memberToken.token)).status, 404)
      assert.equal((await getFile(otherToken.token)).status, 404)
      assert.equal(deliveries.length, before)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_requests')).rows[0].n, 0)
    })

    await t.test('a real GET traverses commands, daemon journal/filesystem, receipt and API response', async () => {
      const response = await getFile(ownerToken.token)
      assert.equal(response.status, 200, JSON.stringify(traffic))
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      const body = await response.json()
      assert.equal(body.kind, 'file'); assert.equal(body.content, source)
      assert.equal(body.identity.runId, runId); assert.equal(body.identity.repoId, repoId)
      assert.equal(body.identity.deviceId, deviceId); assert.equal(body.identity.workspaceId, workspaceId)
      assert.equal(body.revision.headSha, headSha); assert.equal(body.availability, 'online')
      assert.equal('files' in body, false, 'internal full-source proofs are absent from the HTTP result')
      await firstReceipt.promise
      const delivered = deliveries.find(command => command.runId === runId && command.repoId === repoId)
      assert.ok(delivered, 'the real commands response carried this Run\'s read request')
      assert.ok(receipts.some(receipt => receipt.requestId === delivered.id && receipt.status === 204), 'the real daemon POSTed the matching receipt successfully')
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_requests WHERE "runId"=$1', [runId])).rows[0].n, 0)
      // The ordinary stored-session transport also crosses the real HTTP boundary.
      const sessionResponse = await getFile(session.token)
      assert.equal(sessionResponse.status, 200)
      assert.equal((await sessionResponse.json()).content, source)
      assert.equal((await getFile(ownerToken.token, '.env')).status, 404)
    })

    await t.test('mention create and resolve cross the same daemon transport and reject changed source', async () => {
      const created = await mention({ action: 'create', selection: { kind: 'file', path: 'src/example.ts', range: { startLine: 1, endLine: 1 } } })
      assert.equal(created.status, 201)
      const reference = (await created.json()).mention
      const saved = (await pool.query('SELECT files FROM coding_workspace_mentions WHERE id=$1', [reference.id])).rows[0].files
      assert.equal('content' in saved[0], false); assert.equal('base64' in saved[0], false)
      const resolved = await mention({ action: 'resolve', ids: [reference.id] })
      assert.equal(resolved.status, 200)
      const context = await resolved.json()
      assert.equal(context.files[0].content, 'export const answer = 42')
      assert.equal('base64' in context.files[0], false)
      assert.equal((await mention({ action: 'resolve', ids: [reference.id] }, memberToken.token)).status, 404)
      // PAT submission cannot impersonate a human session or trigger model work.
      assert.equal((await mention({ action: 'submit', ids: [reference.id], text: 'Review selected source', requestId: randomUUID() })).status, 403)
      await writeFile(join(worktree, 'src/example.ts'), source.replace('42', '43'))
      const stale = await mention({ action: 'resolve', ids: [reference.id] })
      assert.equal(stale.status, 409)
      assert.equal((await stale.json()).code, 'workspace_version_conflict')
    })

    await t.test('revoked real device credentials block both Files and daemon HTTP authentication', async () => {
      await pool.query('UPDATE device_tokens SET "revokedAt"=now() WHERE id=$1', [tokenId])
      await pool.query('SELECT pg_notify($1,$2)', ['mikka_device_work', `token:${tokenId}`])
      assert.equal((await getFile(ownerToken.token)).status, 404)
      await daemon!.syncWithServer()
      assert.equal(daemonStatusSchema.parse(daemon!.status()).signedIn, false)
      assert.ok(traffic.some(item => item.path.includes(`/v1/devices/${deviceId}/`) && item.status === 401))
    })
    assert.equal(traffic.some(item => item.path.endsWith('/claim')), false, 'no Run was claimed or resumed to call a model')
    assert.equal((await pool.query('SELECT status FROM agent_runs WHERE id=$1', [runId])).rows[0].status, 'succeeded')
    assert.ok(deliveries.length >= 5, 'file, session and mention operations all travelled through commands')
  } finally {
    await daemon?.stop()
    await closeHTTP?.()
    loader.deregister()
    for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
    await dropTestDatabase(admin, database, pool, appPool, workspacePool)
    await admin.end()
    await rm(root, { recursive: true, force: true })
  }
})
