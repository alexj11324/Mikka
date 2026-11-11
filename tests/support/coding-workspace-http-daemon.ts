import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer, IncomingMessage } from 'node:http'
import { registerHooks } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { sql } from 'drizzle-orm'
import { apiAliases } from '../../apps/api/compat-aliases.mjs'
import type { ApiRoute } from '../../apps/api/src/routes'
import { daemonStatusSchema, runAssignmentSchema } from '@mikka/protocol'
import { remoteKey } from '@mikka/protocol/repository'
import { WORKSPACE_ERROR_CODES, runWorktreeIdentity, workspaceReadReceipt, type WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_REVIEW_ERROR_CODES, diffFilePage, diffFilePatch, reviewAnchor, reviewBoard, taskReviewRef,
  type ReviewMutation, type TaskReviewRef, type TaskReviewSubmission } from '@mikka/protocol/coding-workspace-review'
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

/** This is the complete local Files/Diff/Task review transport: a real listening HTTP API,
 * real session/PAT/device authentication, PostgreSQL LISTEN, the full daemon,
 * its on-disk RunJournal, and the daemon's default HttpServerLink fetch.
 * No mock transport, direct readWorkspace invocation, browser or model call. */
export function registerHTTPDaemonAcceptance(kind: 'shared' | 'personal') {
  const title = kind === 'shared'
    ? 'Files/Diff/Task review HTTP API → commands → full daemon → receipt → HTTP response on PostgreSQL 17'
    : 'Personal Workspace Files/Diff/Task review keeps one Run source through real HTTP and the full daemon'
  test(title, { skip: !databaseURL, timeout: 240_000 }, async t => {
  const admin = new Pool({ connectionString: databaseURL, max: 1, connectionTimeoutMillis: 5000 })
  const version = Number((await admin.query('SHOW server_version_num')).rows[0].server_version_num)
  assert.ok(version >= 170000 && version < 180000, 'HTTP/daemon acceptance requires PostgreSQL 17')
  const database = `workspace_http_${kind}_${randomUUID().replaceAll('-', '')}_e2e`
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
  const deliveries: Array<{ id: string; runId: string; repoId: string; kind: string; path?: string }> = []
  const receipts: Array<{ requestId: string; status: number; body: WorkspaceReadReceipt }> = []
  const receiptEvents = new Map<string, PromiseWithResolvers<void>>()
  const firstReceipt = Promise.withResolvers<void>()
  const safeErrorCodes = new Set<string>([...WORKSPACE_ERROR_CODES, ...WORKSPACE_REVIEW_ERROR_CODES, 'authRequired'])
  const statusDiagnostic = async (response: Response) => {
    let code: string | null = null
    if (!response.ok) {
      const body: unknown = await response.clone().json().catch(() => null)
      if (body && typeof body === 'object') {
        const candidate = 'code' in body ? body.code : 'error' in body ? body.error : null
        if (typeof candidate === 'string' && safeErrorCodes.has(candidate)) code = candidate
      }
    }
    // Never print a source response, private proof, credential or raw error.
    return JSON.stringify({ status: response.status, code, traffic })
  }
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
      route('/api/runs/[runId]/workspace/diff', ['GET'], () => import('../../app/api/runs/[runId]/workspace/diff/route')),
      route('/api/runs/[runId]/workspace/diff/[snapshotId]/file', ['GET'], () => import('../../app/api/runs/[runId]/workspace/diff/[snapshotId]/file/route')),
      route('/api/runs/[runId]/workspace/diff/[snapshotId]/review', ['GET', 'POST'], () => import('../../app/api/runs/[runId]/workspace/diff/[snapshotId]/review/route')),
      route('/api/tasks/[taskId]/review', ['GET'], () => import('../../app/api/tasks/[taskId]/review/route')),
      route('/api/tasks/[taskId]/review/file', ['GET'], () => import('../../app/api/tasks/[taskId]/review/file/route')),
      route('/api/tasks/[taskId]/review/summary', ['GET'], () => import('../../app/api/tasks/[taskId]/review/summary/route')),
      route('/api/tasks/[taskId]/review/reviewed', ['POST'], () => import('../../app/api/tasks/[taskId]/review/reviewed/route')),
      route('/api/tasks/[taskId]/review/send', ['POST'], () => import('../../app/api/tasks/[taskId]/review/send/route')),
    ]
    const application = createApiHandler(routes)
    const runtime = serve({ manual: true, gracefulShutdown: false, silent: true, trustProxy: false, hostname: '127.0.0.1', port: 0,
      async fetch(request) {
        assert.ok(request.runtime?.node?.req instanceof IncomingMessage, 'requests enter through a TCP socket and srvx NodeRequest')
        const path = new URL(request.url).pathname
        // Observe the actual private TCP receipt without changing the request
        // or response. Complete synthetic source proofs stay in test memory.
        const receipt = request.method === 'POST' && path.includes('/workspace/requests/')
          ? workspaceReadReceipt.parse(await request.clone().json()) : undefined
        const response = await application.fetch(request)
        traffic.push({ method: request.method, path, status: response.status })
        if (path.endsWith('/commands') && response.status === 200) {
          const body = await response.clone().json()
          for (const command of body.workspaceRequests ?? []) {
            deliveries.push({ id: command.id, runId: command.identity.runId, repoId: command.identity.repoId,
              kind: command.request.kind, ...(command.request.kind === 'diff_file' ? { path: command.request.file.path } : {}) })
            if (!receiptEvents.has(command.id)) receiptEvents.set(command.id, Promise.withResolvers<void>())
          }
        }
        if (receipt) {
          const requestId = path.split('/').at(-1)!
          receipts.push({ requestId, status: response.status, body: receipt })
          receiptEvents.get(requestId)?.resolve()
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
    if (kind === 'shared') {
      for (const id of [workspaceId, otherWorkspace]) {
        await pool.query('INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,\'HTTP Files fixture\')', [id, owner])
        for (const user of [owner, member]) await pool.query('INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,\'member\',\'active\')', [id, user, `${user}@example.invalid`])
      }
      await pool.query('INSERT INTO mikka_teams(id,"workspaceId","userId",name,identifier) VALUES($1,$2,$3,\'HTTP Files fixture\',\'HTTPFILES\')', [teamId, workspaceId, owner])
      await pool.query('INSERT INTO mikka_team_members("teamId","userId",role) VALUES($1,$2,\'owner\')', [teamId, owner])
    } else {
      await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name,kind) VALUES($1,$2,'Personal HTTP Files fixture','personal')`, [workspaceId, owner])
      await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,'admin','active')`, [workspaceId, owner, `${owner}@example.invalid`])
      await pool.query(`INSERT INTO mikka_workspaces(id,"userId",name) VALUES($1,$2,'Other HTTP Files fixture')`, [otherWorkspace, owner])
      for (const user of [owner, member]) await pool.query(`INSERT INTO mikka_workspace_members("workspaceId","userId",name,email,role,status) VALUES($1,$2,$2,$3,'member','active')`, [otherWorkspace, user, `${user}@example.invalid`])
      assert.deepEqual((await pool.query('SELECT kind FROM mikka_workspaces WHERE id=$1', [workspaceId])).rows, [{ kind: 'personal' }])
      assert.deepEqual((await pool.query('SELECT "userId",role,status FROM mikka_workspace_members WHERE "workspaceId"=$1', [workspaceId])).rows, [{ userId: owner, role: 'admin', status: 'active' }])
    }
    const { db } = await import('../../lib/db')
    const { withTaskWorkspace } = await import('../../lib/task-workspace')
    const { registerTaskResourceAccess } = await import('../../lib/task-resource-registration')
    await withTaskWorkspace(owner, workspaceId, async workspace => db.transaction(async tx => {
      await tx.execute(sql`INSERT INTO issues(id,"userId","workspaceId","ownershipState",title,content,status,priority,scope)
        VALUES(${issueId},${owner},${workspaceId},'bound','HTTP Files fixture','{"type":"doc","content":[]}','done','normal',${kind === 'personal' ? 'personal' : 'workspace'})`)
      const rawPolicy = await tx.execute(sql`SELECT visibility FROM resource_access_policies WHERE kind='task' AND id=${issueId}::uuid`)
      assert.deepEqual(rawPolicy.rows, [{ visibility: 'shared' }],
        'the production migration chain still creates raw Task roots as shared before the phase-one writer registers them')
      if (kind === 'shared') await tx.execute(sql`INSERT INTO mikka_team_issues("issueId","teamId","workspaceId","userId")
        VALUES(${issueId},${teamId},${workspaceId},${owner})`)
      await registerTaskResourceAccess(tx, { id: issueId, workspaceId, ownerId: owner, workspaceKind: workspace.kind })
    }))
    assert.deepEqual((await pool.query('SELECT visibility FROM resource_access_policies WHERE kind=\'task\' AND id=$1', [issueId])).rows,
      [{ visibility: kind === 'personal' ? 'private' : 'shared' }])
    if (kind === 'personal') assert.equal((await pool.query('SELECT count(*)::int AS n FROM mikka_team_issues WHERE "issueId"=$1', [issueId])).rows[0].n, 0)
    const runId = randomUUID(), repoId = randomUUID(), deviceId = randomUUID(), tokenId = randomUUID(), agentId = randomUUID()
    const dataDir = join(root, 'daemon'), worktree = join(dataDir, 'worktrees', runId)
    const remote = `https://github.com/mikka-http-fixtures/${runId}.git`, repositoryKey = remoteKey(remote)
    const { daemonPaths } = await import('../../packages/daemon/src/paths')
    const { RepositoryCache } = await import('../../packages/daemon/src/repositories')
    const { WorktreeManager } = await import('../../packages/daemon/src/worktrees')
    const paths = daemonPaths(dataDir), repository = new RepositoryCache(paths.repos).pathFor(remote)
    const seed = join(root, 'seed')
    const source = 'export const answer = 42\nexport const transport = "real HTTP and daemon"\n'
    await mkdir(join(seed, 'src'), { recursive: true })
    await writeFile(join(seed, 'src/example.ts'), source)
    await writeFile(join(seed, 'src/lazy.ts'), 'export const lazy = "base"\n')
    await writeFile(join(seed, '.gitignore'), '.env\n')
    await execute('git', ['init', '--initial-branch=main', seed])
    await execute('git', ['-C', seed, 'add', '.'])
    await execute('git', ['-C', seed, '-c', 'user.name=Mikka fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-m', 'HTTP Files fixture'])
    const headSha = (await execute('git', ['-C', seed, 'rev-parse', 'HEAD'])).stdout.trim()
    // Diff resolves Git through the daemon-owned cache, never a source .git.
    // Seed it locally without fetching the synthetic GitHub remote, then use
    // the normal manager to register this Run's linked worktree.
    await mkdir(dirname(repository), { recursive: true })
    await execute('git', ['clone', '--no-hardlinks', '--no-checkout', seed, repository])
    await execute('git', ['-C', repository, 'remote', 'set-url', 'origin', remote])
    assert.equal(await new WorktreeManager(paths.worktrees, true).create(runId, repository, headSha), worktree)
    assert.equal((await execute('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim(), headSha)
    await writeFile(join(worktree, '.env'), 'SYNTHETIC_PRIVATE=value\n')
    const { newDeviceToken, hashDeviceToken } = await import('../../lib/device-link')
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
    await writeFile(paths.device, JSON.stringify({ credential, deviceId, workspaceId }), { mode: 0o600 })
    new RunJournal(paths.journal).put({
      assignment: runAssignmentSchema.parse({ runId, issueId, repoId, deviceId, remoteUrl: remote, baseBranch: 'main', harness: 'codex', prompt: 'Retained source fixture', kind: 'implement' }),
      state: 'succeeded', sessionId: null, worktree, baseCommit: headSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString(),
    })
    const { auth } = await import('../../lib/auth')
    const { createLegacyPersonalAccessToken } = await import('../../lib/tokens/store')
    const ownerToken = await createLegacyPersonalAccessToken(owner, workspaceId, { name: 'HTTP Files owner' })
    const memberToken = await createLegacyPersonalAccessToken(member, kind === 'personal' ? otherWorkspace : workspaceId, { name: 'HTTP Files member' })
    const otherToken = await createLegacyPersonalAccessToken(owner, otherWorkspace, { name: 'HTTP Files other workspace' })
    const session = await (await auth.$context).internalAdapter.createSession(owner)
    assert.ok(session)
    appPool = (await import('../../lib/db')).pool; workspacePool = (await import('../../lib/workspace-db')).workspacePool
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
    const retainedRun = new RunJournal(paths.journal).get(runId)
    assert.ok(retainedRun)
    assert.equal(retainedRun.state, 'succeeded')
    assert.equal(retainedRun.worktree, worktree)
    assert.equal(retainedRun.baseCommit, headSha)
    assert.equal((await execute('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim(), headSha, 'startup preserves the retained Run checkout')
    assert.equal(await readFile(join(worktree, 'src/example.ts'), 'utf8'), source)
    const endpoint = `${origin}/mikka/api/runs/${runId}/workspace`
    const getIdentity = (token?: string, selectedWorkspace = workspaceId) => fetch(`${endpoint}/identity?${new URLSearchParams({ workspaceId: selectedWorkspace })}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000),
    })
    // A real client knows its Run, not the task VM's database repo binding.
    // Discover that binding through the authenticated API before Files/Mentions.
    const discovery = await getIdentity(ownerToken.token)
    assert.equal(discovery.status, 200, await statusDiagnostic(discovery))
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
      assert.equal(response.status, 200, await statusDiagnostic(response))
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

    await t.test('Diff proofs and two inline drafts cross real HTTP, retain old anchors and fence changed or stopped live reads', async () => {
      const query = new URLSearchParams({ workspaceId, repoId: clientIdentity.repoId })
      const getDiff = (token?: string) => fetch(`${endpoint}/diff?${query}&source=working`, {
        headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000),
      })
      const getDiffFile = (snapshotId: string, path: string) => fetch(`${endpoint}/diff/${snapshotId}/file?${query}&${new URLSearchParams({ path })}`, {
        headers: { authorization: `Bearer ${ownerToken.token}` }, signal: AbortSignal.timeout(20_000),
      })
      const getReview = (snapshotId: string, token = ownerToken.token) => fetch(`${endpoint}/diff/${snapshotId}/review?${query}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000),
      })
      const mutateReview = (snapshotId: string, mutation: ReviewMutation, token = ownerToken.token) => fetch(`${endpoint}/diff/${snapshotId}/review`, {
        method: 'POST', headers: { authorization: `Bearer ${token}`, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, repoId: clientIdentity.repoId, mutation }), signal: AbortSignal.timeout(20_000),
      })
      const beforeDenied = deliveries.length
      assert.equal((await getDiff()).status, 401)
      assert.equal((await getDiff(memberToken.token)).status, 404)
      assert.equal((await getDiff(otherToken.token)).status, 404)
      assert.equal(deliveries.length, beforeDenied, 'unauthorized Diff reads never reach the daemon')

      const changedSource = source.replace('42', '43').replace('real HTTP and daemon', 'Diff over real HTTP')
      await writeFile(join(worktree, 'src/example.ts'), changedSource)
      await writeFile(join(worktree, 'src/lazy.ts'), 'export const lazy = "first observation"\n')
      const beforeCapture = deliveries.length
      const response = await getDiff(ownerToken.token)
      assert.equal(response.status, 200, await statusDiagnostic(response))
      assert.equal(response.headers.get('cache-control'), 'private, no-store')
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
      const { ok, ...value } = await response.json()
      assert.equal(ok, true)
      const page = diffFilePage.parse(value), snapshot = page.snapshot
      assert.equal(snapshot.identity.runId, runId); assert.equal(snapshot.identity.repoId, repoId)
      assert.equal(snapshot.identity.workspaceId, workspaceId); assert.equal(snapshot.identity.repositoryKey, repositoryKey)
      assert.equal(snapshot.revision.source, 'working'); assert.equal(snapshot.revision.baseSha, headSha); assert.equal(snapshot.revision.headSha, headSha)
      assert.equal(snapshot.policy, 'combined_working_tree'); assert.equal(snapshot.availability, 'available')
      assert.equal(snapshot.isStale, false); assert.equal(snapshot.counts.files, 2)
      assert.deepEqual(page.files.map(file => file.path).sort(), ['src/example.ts', 'src/lazy.ts'])
      assert.equal(page.boardRevision, 0)
      const capture = deliveries.slice(beforeCapture).find(command => command.kind === 'diff_snapshot')
      assert.ok(capture && capture.runId === runId && capture.repoId === repoId)
      await receiptEvents.get(capture.id)!.promise
      assert.ok(receipts.some(receipt => receipt.requestId === capture.id && receipt.status === 204
        && receipt.body.result.ok && receipt.body.result.kind === 'diff_snapshot'))

      const beforeFile = deliveries.length
      const fileResponse = await getDiffFile(snapshot.id, 'src/example.ts')
      assert.equal(fileResponse.status, 200, await statusDiagnostic(fileResponse))
      const publicFile = await fileResponse.json()
      assert.equal(publicFile.ok, true)
      assert.doesNotMatch(JSON.stringify(publicFile), /"(?:base64|blobs)"/)
      const patch = diffFilePatch.parse(publicFile.file)
      assert.equal(patch.snapshotId, snapshot.id); assert.equal(patch.sourceVersion, snapshot.revision.version)
      assert.equal(patch.format, 'text'); assert.ok(patch.patch)
      assert.match(patch.patch, /^-export const answer = 42$/m); assert.match(patch.patch, /^\+export const answer = 43$/m)
      assert.equal(patch.hunks.length, 1)
      const delivered = deliveries.slice(beforeFile).find(command => command.kind === 'diff_file' && command.path === 'src/example.ts')
      assert.ok(delivered && delivered.runId === runId && delivered.repoId === repoId)
      await receiptEvents.get(delivered.id)!.promise
      const receipt = receipts.find(item => item.requestId === delivered.id && item.status === 204)?.body
      assert.ok(receipt?.result.ok && receipt.result.kind === 'diff_file')
      assert.equal(receipt.result.patch, null); assert.deepEqual(receipt.result.hunks, []); assert.deepEqual(receipt.files, [])
      const oldBlob = (await execute('git', ['-C', worktree, 'rev-parse', 'HEAD:src/example.ts'])).stdout.trim()
      const newBlob = (await execute('git', ['-C', worktree, 'hash-object', 'src/example.ts'])).stdout.trim()
      assert.equal(patch.file.oldBlob, oldBlob); assert.equal(patch.file.newBlob, newBlob)
      assert.deepEqual(receipt.blobs?.map(proof => ({ sha: proof.sha, base64: proof.base64 })).sort((a, b) => a.sha.localeCompare(b.sha)), [
        { sha: oldBlob, base64: Buffer.from(source).toString('base64') },
        { sha: newBlob, base64: Buffer.from(changedSource).toString('base64') },
      ].sort((a, b) => a.sha.localeCompare(b.sha)), 'the daemon sends complete Git source proofs; only the server constructs public hunks')
      const retained = (await pool.query('SELECT metadata,patch FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=$2', [snapshot.id, patch.file.path])).rows[0]
      assert.deepEqual(retained.patch, patch)
      assert.doesNotMatch(JSON.stringify(retained), /"(?:base64|blobs)"/)

      const anchor = { snapshotId: snapshot.id, sourceVersion: snapshot.revision.version, path: patch.file.path,
        side: 'RIGHT' as const, lineStart: 1, lineEnd: 1, hunkFingerprint: patch.hunks[0]!.fingerprint }
      const firstInput: ReviewMutation = { action: 'create', requestId: randomUUID(), expectedRevision: 0,
        anchor, body: 'Check the changed answer', draft: true }
      const created = await mutateReview(snapshot.id, firstInput)
      assert.equal(created.status, 200)
      const first = await created.json()
      assert.equal(first.ok, true); assert.equal(first.revision, 1); assert.ok(first.commentId)
      const secondResponse = await mutateReview(snapshot.id, { action: 'create', requestId: randomUUID(), expectedRevision: 1,
        anchor: { ...anchor, lineStart: 2, lineEnd: 2 }, body: 'Check the changed transport', draft: true })
      assert.equal(secondResponse.status, 200)
      const second = await secondResponse.json()
      assert.equal(second.ok, true); assert.equal(second.revision, 2); assert.ok(second.commentId)
      assert.notEqual(second.commentId, first.commentId)
      const replay = await mutateReview(snapshot.id, firstInput)
      assert.equal(replay.status, 200); assert.deepEqual(await replay.json(), first)
      const conflictingReplay = await mutateReview(snapshot.id, { ...firstInput, body: 'Different body with the same request id' })
      assert.equal(conflictingReplay.status, 409); assert.equal((await conflictingReplay.json()).code, 'workspace_review_conflict')
      const boardResponse = await getReview(snapshot.id)
      assert.equal(boardResponse.status, 200)
      const { ok: boardOK, ...boardValue } = await boardResponse.json()
      assert.equal(boardOK, true)
      const board = reviewBoard.parse(boardValue)
      assert.equal(board.revision, 2); assert.equal(board.comments.length, 2)
      assert.deepEqual(board.comments.map(comment => comment.id).sort(), [first.commentId, second.commentId].sort())
      assert.ok(board.comments.every(comment => comment.draft && !comment.outdated && comment.anchor.snapshotId === snapshot.id))
      assert.equal(board.permissions.canSendToAgent, false, 'PAT review drafts do not authorize model work')
      if (kind === 'shared') {
        // This workspace-scoped Task is visible to members through its team link.
        // Historical board access does not expose another author's private drafts.
        const memberResponse = await getReview(snapshot.id, memberToken.token)
        assert.equal(memberResponse.status, 200, await statusDiagnostic(memberResponse))
        const memberBody = await memberResponse.json(), { ok: memberOK, ...memberValue } = memberBody
        assert.equal(memberOK, true)
        const memberBoard = reviewBoard.parse(memberValue)
        assert.deepEqual(memberBoard.comments, []); assert.equal(memberBoard.nextCursor, null)
        assert.equal(memberBoard.permissions.canReadLive, false); assert.equal(memberBoard.permissions.canSendToAgent, false)
        const serializedMember = JSON.stringify(memberBody)
        for (const comment of board.comments) for (const privateValue of [comment.id, comment.threadId, comment.body])
          assert.equal(serializedMember.includes(privateValue), false, 'a member response must contain no private draft identifiers or body')
        assert.equal((await getReview(snapshot.id, otherToken.token)).status, 404)

        for (const comment of board.comments) {
          const mutations: ReviewMutation[] = [
            { action: 'reply', requestId: randomUUID(), expectedRevision: board.revision,
              threadId: comment.threadId, body: 'Member reply to an owner private draft must be refused' },
            { action: 'edit', requestId: randomUUID(), expectedRevision: board.revision,
              commentId: comment.id, body: 'Member edit of an owner private draft must be refused' },
          ]
          for (const mutation of mutations) {
            const denied = await mutateReview(snapshot.id, mutation, memberToken.token)
            assert.equal(denied.status, 409, await statusDiagnostic(denied))
            assert.deepEqual(await denied.json(), { ok: false, code: 'workspace_review_unavailable' })
          }
        }
        const unchangedResponse = await getReview(snapshot.id)
        assert.equal(unchangedResponse.status, 200)
        const { ok: unchangedOK, ...unchangedValue } = await unchangedResponse.json()
        assert.equal(unchangedOK, true)
        const unchangedBoard = reviewBoard.parse(unchangedValue)
        assert.equal(unchangedBoard.revision, board.revision); assert.deepEqual(unchangedBoard.comments, board.comments)
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_review_receipts WHERE "requestId"=$1', [firstInput.requestId])).rows[0].n, 1)
      } else {
        const beforePersonalRefusal = deliveries.length
        const denied = await getReview(snapshot.id, memberToken.token)
        assert.equal(denied.status, 404)
        assert.deepEqual(await denied.json(), { ok: false, code: 'workspace_not_found' })
        const mutation = await mutateReview(snapshot.id, { action: 'reply', requestId: randomUUID(), expectedRevision: board.revision,
          threadId: board.comments[0]!.threadId, body: 'An outsider cannot reply to a personal review' }, memberToken.token)
        assert.equal(mutation.status, 404)
        assert.equal(deliveries.length, beforePersonalRefusal, 'a personal outsider never requests machine source')
      }

      await writeFile(join(worktree, 'src/example.ts'), changedSource.replace('43', '44'))
      await writeFile(join(worktree, 'src/lazy.ts'), 'export const lazy = "second observation"\n')
      const beforeRetained = deliveries.length
      const oldCached = await getDiffFile(snapshot.id, 'src/example.ts')
      assert.equal(oldCached.status, 200); assert.deepEqual((await oldCached.json()).file, patch)
      assert.equal(deliveries.length, beforeRetained, 'retained history does not silently read or replace newer live bytes')
      const oldUncached = await getDiffFile(snapshot.id, 'src/lazy.ts')
      assert.equal(oldUncached.status, 409); assert.equal((await oldUncached.json()).code, 'workspace_version_conflict')
      assert.equal((await pool.query('SELECT patch FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=$2', [snapshot.id, 'src/lazy.ts'])).rows[0].patch, null)
      const freshResponse = await getDiff(ownerToken.token)
      assert.equal(freshResponse.status, 200, await statusDiagnostic(freshResponse))
      const { ok: freshOK, ...freshValue } = await freshResponse.json()
      assert.equal(freshOK, true)
      const fresh = diffFilePage.parse(freshValue).snapshot
      assert.notEqual(fresh.id, snapshot.id); assert.notEqual(fresh.revision.version, snapshot.revision.version)
      const outdatedResponse = await getReview(fresh.id)
      assert.equal(outdatedResponse.status, 200)
      const { ok: outdatedOK, ...outdatedValue } = await outdatedResponse.json()
      assert.equal(outdatedOK, true)
      const outdated = reviewBoard.parse(outdatedValue)
      assert.equal(outdated.comments.length, 2); assert.ok(outdated.comments.every(comment => comment.outdated))
      assert.ok(outdated.comments.every(comment => comment.anchor.snapshotId === snapshot.id), 'old anchors are never retargeted to a fresh snapshot')
      const wrongAnchor = await mutateReview(fresh.id, { ...firstInput, requestId: randomUUID(), expectedRevision: 2 })
      assert.equal(wrongAnchor.status, 409); assert.equal((await wrongAnchor.json()).code, 'workspace_review_anchor_invalid')

      await pool.query('UPDATE agent_runs SET "stopRequestedAt"=now() WHERE id=$1', [runId])
      try {
        const beforeStop = deliveries.length
        for (const stopped of [await getDiff(ownerToken.token), await getDiffFile(fresh.id, 'src/lazy.ts')]) {
          assert.equal(stopped.status, 409); assert.equal((await stopped.json()).code, 'workspace_machine_unavailable')
        }
        const history = await getDiffFile(snapshot.id, 'src/example.ts')
        assert.equal(history.status, 200); assert.deepEqual((await history.json()).file, patch)
        const stoppedBoard = await getReview(fresh.id)
        assert.equal(stoppedBoard.status, 200); assert.equal((await stoppedBoard.json()).permissions.canReadLive, false)
        assert.equal(deliveries.length, beforeStop, 'Stop prevents both new live snapshots and lazy file source requests')
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_requests WHERE "runId"=$1', [runId])).rows[0].n, 0)
      } finally { await pool.query('UPDATE agent_runs SET "stopRequestedAt"=NULL WHERE id=$1', [runId]) }
    })

    await t.test('Task review routes keep native source, human writes and durable inbox delivery on the real HTTP path', async t => {
      const taskEndpoint = `${origin}/mikka/api/tasks/${issueId}/review`
      const taskGet = (suffix = '', query: Record<string, string> = {}, token: string | null = session.token, selectedWorkspace = workspaceId) =>
        fetch(`${taskEndpoint}${suffix}?${new URLSearchParams({ workspaceId: selectedWorkspace, ...query })}`, {
          headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20_000),
        })
      const taskPost = (suffix: string, input: Record<string, unknown>, options: { token?: string; origin?: string; workspaceId?: string } = {}) =>
        fetch(`${taskEndpoint}/${suffix}`, { method: 'POST',
          headers: { authorization: `Bearer ${options.token ?? session.token}`, 'content-type': 'application/json',
            ...(options.origin !== undefined ? { origin: options.origin } : {}) },
          body: JSON.stringify({ workspaceId: options.workspaceId ?? workspaceId, ...input }), signal: AbortSignal.timeout(30_000),
        })
      const refQuery = (reference: TaskReviewRef) => ({ snapshotId: reference.snapshotId, sourceVersion: reference.sourceVersion })
      const taskFile = (reference: TaskReviewRef, path: string, token = session.token, selectedWorkspace = workspaceId) =>
        taskGet('/file', { ...refQuery(reference), path }, token, selectedWorkspace)
      const { rows: [originalRun] } = await pool.query('SELECT status,"finishedAt","leaseExpiresAt","botId","agentDefinition" FROM agent_runs WHERE id=$1', [runId])
      const botId = randomUUID(), secretId = randomUUID()
      const secretParts = ['http-private-start-' + randomUUID(), 'http-private-end-' + randomUUID()]
      const secretValue = secretParts.join('\n'), hiddenText = 'hidden-directory-' + randomUUID()
      const safePublic = (value: unknown) => {
        const serialized = JSON.stringify(value)
        for (const privateValue of [...secretParts, hiddenText, '.mikka/http-private.txt', '.env'])
          assert.equal(serialized.includes(privateValue), false, 'Task HTTP responses never expose protected paths or source values')
        for (const field of ['base64', 'blobs', 'rawBlob', 'rawSize', 'oldBlob', 'newBlob', 'workingVersion',
          'maskPolicy', 'sourcePolicy', 'bindingId', 'repositoryKey', 'worktreePath'])
          assert.equal(serialized.includes('"' + field + '"'), false, 'Task HTTP projections exclude private proof and machine metadata')
      }
      const { admitRepositoryTask } = await import('../../lib/repository-admission')
      const { sealSecret, userSecretAad } = await import('../../lib/secrets/crypto')
      const admission = admitRepositoryTask({ userId: owner, issueId, deviceId, agentId, remoteKey: repositoryKey,
        remoteUrl: remote, targetBranch: 'mikka/http-review-1', workspaceId, now: new Date() })
      assert.ok(admission)
      await pool.query('INSERT INTO bots(id,"workspaceId","ownerId",name) VALUES($1,$2,$3,\'HTTP Task review\')', [botId, workspaceId, owner])
      // The server's real live inbox has a complete repository admission. The
      // harnessless daemon keeps its terminal journal: it reads source but
      // never starts a model to prove durable message acceptance.
      await pool.query(`UPDATE agent_runs SET status='running',"finishedAt"=NULL,"leaseExpiresAt"=now()+interval '10 minutes',
        "botId"=$2,"agentDefinition"=$3 WHERE id=$1`, [runId, botId,
        { executionIdentity: { workspaceId }, repositoryAdmission: admission }])
      const secretRow = { id: secretId, userId: owner, name: 'HTTP_REVIEW_SECRET', kind: 'secret' }
      const sealed = sealSecret(secretValue, userSecretAad(secretRow))
      await pool.query('INSERT INTO user_secrets(id,"userId",name,kind,ciphertext,iv,"keyVersion") VALUES($1,$2,$3,$4,$5,$6,$7)',
        [secretRow.id, owner, secretRow.name, secretRow.kind, sealed.ciphertext, sealed.iv, sealed.keyVersion])
      const taskSource = source.replace('42', '45').replace('real HTTP and daemon', 'Task Review over TCP')
      await writeFile(join(worktree, 'src/example.ts'), taskSource)
      await writeFile(join(worktree, 'src/lazy.ts'), 'export const lazy = "Task first observation"\n')
      await writeFile(join(worktree, 'src/sensitive.ts'), secretValue + '\n')
      await mkdir(join(worktree, '.mikka'), { recursive: true })
      await writeFile(join(worktree, '.mikka/http-private.txt'), hiddenText)
      try {
        const beforeCapture = deliveries.length
        const response = await taskGet()
        assert.equal(response.status, 200, await statusDiagnostic(response))
        const initial = await response.json(), firstRef = taskReviewRef.parse(initial.diff.reviewRef)
        let currentRef = firstRef
        const initialFile = initial.diff.files.find((file: { path: string }) => file.path === 'src/example.ts')
        assert.ok(initialFile)
        const storedPatch = async (reference: TaskReviewRef, path = 'src/example.ts') => diffFilePatch.parse(
          (await pool.query('SELECT patch FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=$2', [reference.snapshotId, path])).rows[0]?.patch)

        await t.test('GET review, file and summary use actual daemon receipts and return only public projections', async () => {
          safePublic(initial)
          assert.equal(response.headers.get('cache-control'), 'private, no-store')
          assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
          assert.deepEqual(initial.summary.reviewRef, firstRef)
          assert.equal(initial.summary.taskId, issueId); assert.equal(initial.summary.running, true)
          assert.equal(initial.summary.permissions.canSend, true)
          assert.equal(initial.diff.source.kind, 'machine'); assert.equal(initial.diff.live, true)
          assert.equal(initial.diff.base, headSha); assert.equal(initial.diff.head, headSha)
          assert.deepEqual(initial.diff.files.map((file: { path: string }) => file.path).sort(), ['src/example.ts', 'src/lazy.ts', 'src/sensitive.ts'])
          assert.equal(initialFile.format, 'unloaded'); assert.equal(initialFile.countsKnown, false)
          assert.equal(initialFile.additions, null); assert.equal(initialFile.deletions, null)
          const capture = deliveries.slice(beforeCapture).find(command => command.kind === 'diff_snapshot')
          assert.ok(capture && capture.runId === runId && capture.repoId === repoId)
          await receiptEvents.get(capture.id)!.promise
          assert.ok(receipts.some(receipt => receipt.requestId === capture.id && receipt.status === 204
            && receipt.body.result.ok && receipt.body.result.kind === 'diff_snapshot'))
          const beforeFile = deliveries.length, fileResponse = await taskFile(firstRef, 'src/example.ts')
          assert.equal(fileResponse.status, 200, await statusDiagnostic(fileResponse))
          const file = await fileResponse.json(); safePublic(file)
          assert.deepEqual(file.reviewRef, firstRef); assert.deepEqual(file.comments, [])
          assert.equal(file.file.format, 'text'); assert.equal(file.file.countsKnown, true)
          assert.match(file.file.patch, /^\+export const answer = 45$/m)
          assert.equal(file.file.fileVersion, initialFile.fileVersion)
          const command = deliveries.slice(beforeFile).find(item => item.kind === 'diff_file' && item.path === 'src/example.ts')
          assert.ok(command && command.runId === runId && command.repoId === repoId)
          await receiptEvents.get(command.id)!.promise
          assert.ok(receipts.some(receipt => receipt.requestId === command.id && receipt.status === 204
            && receipt.body.result.ok && receipt.body.result.kind === 'diff_file' && (receipt.body.blobs?.length ?? 0) > 0))
          const beforeSummary = deliveries.length, summaryResponse = await taskGet('/summary')
          assert.equal(summaryResponse.status, 200, await statusDiagnostic(summaryResponse))
          const summary = await summaryResponse.json(); safePublic(summary)
          assert.deepEqual(summary.reviewRef, firstRef); assert.equal(summary.files, 3)
          assert.equal(summary.countsKnown, false); assert.equal(summary.additions, null); assert.equal(summary.checks, null)
          assert.equal(deliveries.length, beforeSummary, 'summary reads retained metadata without fetching source')
        })

        await t.test('reviewed POST accepts a real native session without Origin, refuses foreign Origin and persists one idempotent mark', async () => {
          const input = { reviewRef: firstRef, idempotencyKey: randomUUID(), expectedRevision: initial.diff.boardRevision,
            files: [{ path: 'src/example.ts', fileVersion: initialFile.fileVersion, reviewed: true }] }
          const before = deliveries.length
          const denied = await taskPost('reviewed', input, { origin: 'https://foreign.example.invalid' })
          assert.equal(denied.status, 403); assert.deepEqual(await denied.json(), { error: 'workspace_not_found' })
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_reviewed_files WHERE "userId"=$1', [owner])).rows[0].n, 0)
          const marked = await taskPost('reviewed', input)
          assert.equal(marked.status, 200, await statusDiagnostic(marked))
          const receipt = await marked.json(); safePublic(receipt)
          assert.deepEqual(receipt.reviewRef, firstRef); assert.equal(receipt.changed, 1)
          const sameOriginReplay = await taskPost('reviewed', input, { origin })
          assert.equal(sameOriginReplay.status, 200); assert.deepEqual(await sameOriginReplay.json(), receipt)
          const rows = (await pool.query('SELECT path,"fileVersion" FROM coding_workspace_reviewed_files WHERE "userId"=$1', [owner])).rows
          assert.deepEqual(rows, [{ path: 'src/example.ts', fileVersion: initialFile.fileVersion }])
          const viewed = await taskFile(firstRef, 'src/example.ts')
          assert.equal(viewed.status, 200); assert.equal((await viewed.json()).file.viewed, true)
          assert.equal(deliveries.length, before, 'local marks and retained file reads do not refetch source')
        })

        await t.test('changed native source conflicts with an unloaded old file and mismatched references without retargeting old content', async () => {
          const originalPatch = await storedPatch(firstRef)
          await writeFile(join(worktree, 'src/example.ts'), taskSource.replace('45', '46'))
          await writeFile(join(worktree, 'src/lazy.ts'), 'export const lazy = "Task second observation"\n')
          const beforeCached = deliveries.length, cached = await taskFile(firstRef, 'src/example.ts')
          assert.equal(cached.status, 200); assert.equal((await cached.json()).file.patch, originalPatch.patch)
          assert.equal(deliveries.length, beforeCached)
          const stale = await taskFile(firstRef, 'src/lazy.ts')
          assert.equal(stale.status, 409, await statusDiagnostic(stale))
          assert.deepEqual(await stale.json(), { error: 'workspace_version_conflict' })
          const freshResponse = await taskGet()
          assert.equal(freshResponse.status, 200, await statusDiagnostic(freshResponse))
          const fresh = await freshResponse.json(); safePublic(fresh)
          currentRef = taskReviewRef.parse(fresh.diff.reviewRef)
          assert.notEqual(currentRef.snapshotId, firstRef.snapshotId); assert.notEqual(currentRef.sourceVersion, firstRef.sourceVersion)
          const freshFile = fresh.diff.files.find((file: { path: string }) => file.path === 'src/example.ts')
          assert.ok(freshFile); assert.notEqual(freshFile.fileVersion, initialFile.fileVersion); assert.equal(freshFile.viewed, false)
          const beforeWrongRef = deliveries.length
          const wrongRef = await taskFile({ ...firstRef, sourceVersion: currentRef.sourceVersion }, 'src/example.ts')
          assert.equal(wrongRef.status, 409); assert.deepEqual(await wrongRef.json(), { error: 'workspace_snapshot_outdated' })
          const wrongMark = await taskPost('reviewed', { reviewRef: currentRef, idempotencyKey: randomUUID(), expectedRevision: fresh.diff.boardRevision,
            files: [{ path: 'src/example.ts', fileVersion: initialFile.fileVersion, reviewed: true }] })
          assert.equal(wrongMark.status, 409); assert.deepEqual(await wrongMark.json(), { error: 'workspace_snapshot_outdated' })
          assert.equal(deliveries.length, beforeWrongRef, 'invalid references are refused before any source request')
        })

        await t.test('owner send proves current source through the real daemon, freezes the displayed line and commits exactly one inbox message', async () => {
          const fileResponse = await taskFile(currentRef, 'src/example.ts')
          assert.equal(fileResponse.status, 200, await statusDiagnostic(fileResponse))
          const file = await fileResponse.json(); safePublic(file)
          assert.match(file.file.patch, /^\+export const answer = 46$/m)
          const input: TaskReviewSubmission = { reviewRef: currentRef, idempotencyKey: randomUUID(), attachedChecks: [],
            comments: [{ path: 'src/example.ts', line: 1, side: 'new', body: 'Please explain the changed answer.' }], note: 'Keep the original task branch.' }
          const memberSession = await (await auth.$context).internalAdapter.createSession(member)
          assert.ok(memberSession)
          const beforeDenied = deliveries.length
          for (const token of [ownerToken.token, ...(kind === 'shared' ? [memberSession.token] : [])]) {
            const denied = await taskPost('send', input, { token })
            assert.equal(denied.status, 403, await statusDiagnostic(denied))
            assert.deepEqual(await denied.json(), { error: 'not_owner_send', reason: 'not_owner_send' })
          }
          if (kind === 'personal') {
            const outsider = await taskPost('send', input, { token: memberSession.token })
            assert.equal(outsider.status, 404)
            assert.deepEqual(await outsider.json(), { error: 'workspace_not_found' })
          }
          assert.equal(deliveries.length, beforeDenied)
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1', [runId])).rows[0].n, 0)
          const sent = await taskPost('send', input)
          assert.equal(sent.status, 200, await statusDiagnostic(sent))
          const result = await sent.json(); safePublic(result)
          assert.equal(result.state, 'sent'); assert.equal(result.agent.state, 'accepted'); assert.equal(result.github, null)
          assert.equal(result.agent.delivery.kind, 'run_message'); assert.equal(result.agent.delivery.runId, runId)
          assert.equal(result.agent.delivery.messageId, result.messageId); assert.equal(result.attempt, 1)
          const preflight = deliveries.slice(beforeDenied).find(command => command.kind === 'diff_snapshot')
          assert.ok(preflight && preflight.runId === runId && preflight.repoId === repoId, 'delivery proves its exact source through the real daemon')
          await receiptEvents.get(preflight.id)!.promise
          assert.ok(receipts.some(receipt => receipt.requestId === preflight.id && receipt.status === 204
            && receipt.body.result.ok && receipt.body.result.kind === 'diff_snapshot'))
          const { rows: [batch] } = await pool.query('SELECT input,receipt,state FROM coding_workspace_review_batches WHERE id=$1', [result.agent.batchId])
          assert.ok(batch); assert.equal(batch.state, 'accepted')
          assert.equal(batch.input.agent.comments.length, 1)
          const comment = batch.input.agent.comments[0], anchor = reviewAnchor.parse(comment.anchor), patch = await storedPatch(currentRef)
          assert.deepEqual(anchor, { ...currentRef, path: 'src/example.ts', side: 'RIGHT', lineStart: 1, lineEnd: 1,
            hunkFingerprint: patch.hunks[0]!.fingerprint })
          assert.equal(comment.body, input.comments[0]!.body)
          const messages = (await pool.query('SELECT id,"runId","userId",text,origin,"mailboxWakeDepth" FROM run_messages WHERE "runId"=$1', [runId])).rows
          assert.deepEqual(messages, [{ id: result.messageId, runId, userId: owner, text: batch.input.agent.text, origin: 'owner', mailboxWakeDepth: -1 }])
          assert.ok(messages[0].text.includes(input.comments[0]!.body)); assert.ok(messages[0].text.includes(input.note!))
          const beforeReplay = deliveries.length
          for (const retry of [input, { ...input, idempotencyKey: randomUUID() }]) {
            const repeated = await taskPost('send', retry)
            assert.equal(repeated.status, 200); assert.deepEqual(await repeated.json(), result)
          }
          assert.equal(deliveries.length, beforeReplay, 'accepted retries reuse the durable source-bound receipt')
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1', [runId])).rows[0].n, 1)
          const published = await taskFile(currentRef, 'src/example.ts')
          assert.equal(published.status, 200)
          const value = await published.json(); safePublic(value)
          assert.equal(value.file.comments, 1); assert.equal(value.comments.length, 1)
          assert.deepEqual({ path: value.comments[0].path, line: value.comments[0].line, side: value.comments[0].side, body: value.comments[0].body }, input.comments[0])
          assert.equal(value.comments[0].id, comment.id)
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_requests WHERE "runId"=$1', [runId])).rows[0].n, 0)
        })

        await t.test('protected directories and complete secret source never enter Task HTTP file responses', async () => {
          const beforeHidden = deliveries.length
          for (const path of ['.env', '.mikka/http-private.txt']) {
            const denied = await taskFile(currentRef, path)
            assert.equal(denied.status, 400); const value = await denied.json(); safePublic(value)
            assert.deepEqual(value, { error: 'workspace_invalid_request' })
          }
          assert.equal(deliveries.length, beforeHidden, 'hidden paths are refused before the daemon')
          const secretResponse = await taskFile(currentRef, 'src/sensitive.ts')
          assert.equal(secretResponse.status, 404, await statusDiagnostic(secretResponse))
          const value = await secretResponse.json(); safePublic(value)
          assert.deepEqual(value, { error: 'workspace_path_unavailable' })
          const secretRead = deliveries.slice(beforeHidden).find(command => command.kind === 'diff_file' && command.path === 'src/sensitive.ts')
          assert.ok(secretRead)
          await receiptEvents.get(secretRead.id)!.promise
          assert.ok(receipts.some(receipt => receipt.requestId === secretRead.id && receipt.status === 204
            && receipt.body.result.ok && receipt.body.result.kind === 'diff_file' && (receipt.body.blobs?.length ?? 0) > 0),
          'the real server refuses a complete private source proof rather than trusting a daemon-authored patch')
          assert.equal((await pool.query('SELECT patch FROM coding_workspace_snapshot_files WHERE "snapshotId"=$1 AND path=$2',
            [currentRef.snapshotId, 'src/sensitive.ts'])).rows[0].patch, null)
        })

        await t.test('wrong Workspace and revoked stored sessions or membership refuse Task routes before source access', async () => {
          const before = deliveries.length
          const unauthenticated = await taskGet('', {}, null)
          assert.equal(unauthenticated.status, 401); assert.deepEqual(await unauthenticated.json(), { error: 'authRequired' })
          const mark = { reviewRef: currentRef, idempotencyKey: randomUUID(), expectedRevision: 0,
            files: [{ path: 'src/example.ts', fileVersion: initialFile.fileVersion, reviewed: true }] }
          for (const denied of [await taskGet('', {}, session.token, otherWorkspace), await taskGet('/summary', {}, session.token, otherWorkspace),
            await taskFile(currentRef, 'src/example.ts', session.token, otherWorkspace), await taskGet('', {}, otherToken.token),
            await taskPost('reviewed', mark, { workspaceId: otherWorkspace })]) {
            assert.equal(denied.status, 404, await statusDiagnostic(denied)); const body = await denied.json(); safePublic(body)
            assert.deepEqual(body, { error: 'workspace_not_found' })
          }
          const revokedSession = await (await auth.$context).internalAdapter.createSession(owner)
          assert.ok(revokedSession)
          assert.equal((await taskGet('/summary', {}, revokedSession.token)).status, 200)
          await pool.query('DELETE FROM "session" WHERE id=$1', [revokedSession.id])
          for (const denied of [await taskGet('', {}, revokedSession.token), await taskFile(currentRef, 'src/example.ts', revokedSession.token),
            await taskPost('reviewed', mark, { token: revokedSession.token })]) {
            assert.equal(denied.status, 401); assert.deepEqual(await denied.json(), { error: 'authRequired' })
          }
          await pool.query('UPDATE mikka_workspace_members SET status=\'suspended\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner])
          try {
            for (const denied of [await taskGet(), await taskGet('/summary'), await taskFile(currentRef, 'src/example.ts'), await taskPost('reviewed', mark)]) {
              assert.equal(denied.status, 404); assert.deepEqual(await denied.json(), { error: 'workspace_not_found' })
            }
          } finally { await pool.query('UPDATE mikka_workspace_members SET status=\'active\' WHERE "workspaceId"=$1 AND "userId"=$2', [workspaceId, owner]) }
          assert.equal(deliveries.length, before, 'authentication and tenant refusals never request machine source')
          assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_messages WHERE "runId"=$1', [runId])).rows[0].n, 1)
        })
      } finally {
        await pool.query('DELETE FROM user_secrets WHERE id=$1', [secretId])
        await pool.query('UPDATE agent_runs SET status=$2,"finishedAt"=$3,"leaseExpiresAt"=$4,"botId"=$5,"agentDefinition"=$6 WHERE id=$1',
          [runId, originalRun.status, originalRun.finishedAt, originalRun.leaseExpiresAt, originalRun.botId, originalRun.agentDefinition])
        await pool.query('DELETE FROM bots WHERE id=$1', [botId])
        await rm(join(worktree, '.mikka'), { recursive: true, force: true })
        await rm(join(worktree, 'src/sensitive.ts'), { force: true })
      }
    })

    if (kind === 'personal') await t.test('retained retry and continuation keep Task provenance without retargeting older Run source', async () => {
      const taskEndpoint = `${origin}/mikka/api/tasks/${issueId}/review`
      const taskRead = (query: Record<string, string> = {}) => fetch(`${taskEndpoint}?${new URLSearchParams({ workspaceId, ...query })}`, {
        headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(20_000),
      })
      const taskFile = (reference: TaskReviewRef) => fetch(`${taskEndpoint}/file?${new URLSearchParams({ workspaceId, ...reference, path: 'src/example.ts' })}`, {
        headers: { authorization: `Bearer ${session.token}` }, signal: AbortSignal.timeout(20_000),
      })
      const oldContent = await readFile(join(worktree, 'src/example.ts'), 'utf8')
      const oldReviewResponse = await taskRead()
      assert.equal(oldReviewResponse.status, 200, await statusDiagnostic(oldReviewResponse))
      const oldRef = taskReviewRef.parse((await oldReviewResponse.json()).diff.reviewRef)
      const oldFileResponse = await taskFile(oldRef)
      assert.equal(oldFileResponse.status, 200)
      const oldFile = await oldFileResponse.json()
      const attempts: Array<{ id: string; content: string }> = []
      await daemon!.stop()
      const journal = new RunJournal(paths.journal)
      const { admitRepositoryTask } = await import('../../lib/repository-admission')
      for (const relation of ['retryOf', 'continuesRunId'] as const) {
        const id = randomUUID(), parentId = attempts.at(-1)?.id ?? runId
        const attemptWorktree = await new WorktreeManager(paths.worktrees, true).create(id, repository, headSha)
        const content = `export const answer = ${relation === 'retryOf' ? '71' : '72'}\nexport const transport = "retained ${relation} fixture"\n`
        await writeFile(join(attemptWorktree, 'src/example.ts'), content)
        const admission = admitRepositoryTask({ userId: owner, issueId, deviceId, agentId, remoteKey: repositoryKey,
          remoteUrl: remote, targetBranch: `mikka/run-${id}`, workspaceId, now: new Date() })
        await pool.query(`INSERT INTO agent_runs(id,"userId","workspaceId","issueId","agentId","deviceId","deviceRepoId","deviceTokenId",status,"worktreePath","finishedAt","agentDefinition","retryOf","continuesRunId")
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',$9,now(),$10,$11,$12)`,
        [id, owner, workspaceId, issueId, agentId, deviceId, repoId, tokenId, attemptWorktree,
          { executionIdentity: { workspaceId }, repositoryAdmission: admission }, relation === 'retryOf' ? parentId : null, relation === 'continuesRunId' ? parentId : null])
        journal.put({ assignment: runAssignmentSchema.parse({ runId: id, issueId, repoId, deviceId, remoteUrl: remote,
          baseBranch: 'main', harness: 'codex', prompt: 'Retained personal attempt fixture', kind: 'implement' }),
        state: 'succeeded', sessionId: null, worktree: attemptWorktree, baseCommit: headSha, lastSeq: 0,
        error: null, updatedAt: new Date().toISOString() })
        attempts.push({ id, content })
      }
      const restartLink: unknown = Reflect.construct(linkModule.HttpServerLink as Function, [`${origin}/mikka`])
      daemon = fixtureDaemon(await Reflect.apply(mainModule.startDaemon as Function, undefined, [{ dataDir, flavor: 'dev',
        link: restartLink, credential, harnesses: [], modelProbe: false, agentSandbox: null, quotaSource: null,
        retainResources: true, heartbeatMs: 60_000, commandsWaitSeconds: 25 }]))
      await daemon.syncWithServer()
      for (const attempt of attempts) {
        const request = await fetch(`${origin}/mikka/api/runs/${attempt.id}/workspace/files?${new URLSearchParams({ workspaceId, repoId, kind: 'file', path: 'src/example.ts' })}`, {
          headers: { authorization: `Bearer ${ownerToken.token}` }, signal: AbortSignal.timeout(20_000),
        })
        assert.equal(request.status, 200, await statusDiagnostic(request))
        const file = await request.json()
        assert.equal(file.identity.runId, attempt.id); assert.equal(file.identity.workspaceId, workspaceId)
        assert.equal(file.content, attempt.content)
      }
      const beforeCurrent = deliveries.length, currentResponse = await taskRead()
      assert.equal(currentResponse.status, 200, await statusDiagnostic(currentResponse))
      const current = await currentResponse.json(), currentRef = taskReviewRef.parse(current.diff.reviewRef)
      assert.notEqual(currentRef.snapshotId, oldRef.snapshotId)
      const currentCapture = deliveries.slice(beforeCurrent).find(command => command.kind === 'diff_snapshot')
      assert.equal(currentCapture?.runId, attempts[1]!.id, 'Task review selects the latest owner continuation, not the old retry')
      const currentFileResponse = await taskFile(currentRef)
      assert.equal(currentFileResponse.status, 200)
      assert.match((await currentFileResponse.json()).file.patch, /^\+export const answer = 72$/m)
      const oldResponse = await getFile(ownerToken.token)
      assert.equal(oldResponse.status, 200); assert.equal((await oldResponse.json()).content, oldContent)
      const retainedReview = await taskRead(oldRef)
      assert.equal(retainedReview.status, 200); assert.deepEqual((await retainedReview.json()).diff.reviewRef, oldRef)
      const retainedFile = await taskFile(oldRef)
      assert.equal(retainedFile.status, 200); assert.deepEqual((await retainedFile.json()).file, oldFile.file)
      const staleSend = await fetch(`${taskEndpoint}/send`, { method: 'POST',
        headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ workspaceId, reviewRef: oldRef, idempotencyKey: randomUUID(), attachedChecks: [],
          comments: [{ path: 'src/example.ts', line: 1, side: 'new', body: 'Old attempt feedback must not reach the new continuation' }] }),
        signal: AbortSignal.timeout(20_000),
      })
      assert.equal(staleSend.status, 409)
      assert.deepEqual(await staleSend.json(), { error: 'workspace_snapshot_outdated' })
      const { readRunChain } = await import('../../lib/run-chain')
      const chain = await readRunChain(pool, owner, attempts[1]!.id)
      assert.ok(chain); assert.equal(chain.rootRunId, runId); assert.equal(chain.latestRunId, attempts[1]!.id)
      assert.deepEqual(chain.attempts.map(attempt => attempt.runId), [runId, ...attempts.map(attempt => attempt.id)])
      assert.equal(await readRunChain(pool, member, attempts[1]!.id), null)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM run_messages WHERE "runId"=ANY($1::uuid[])', [attempts.map(attempt => attempt.id)])).rows[0].n, 0)
      assert.ok(receipts.some(receipt => receipt.requestId === currentCapture!.id && receipt.status === 204
        && receipt.body.result.ok && receipt.body.result.kind === 'diff_snapshot'))
      // All three are explicitly retained fixtures. No continuation API,
      // daemon claim/resume or native model execution is represented here.
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
}
