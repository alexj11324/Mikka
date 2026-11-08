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
import { runWorktreeIdentity, workspaceReadReceipt, type WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import { diffFilePage, diffFilePatch, reviewBoard, type ReviewMutation } from '@mikka/protocol/coding-workspace-review'
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

/** This is the complete local Files/Diff transport: a real listening HTTP API,
 * real session/PAT/device authentication, PostgreSQL LISTEN, the full daemon,
 * its on-disk RunJournal, and the daemon's default HttpServerLink fetch.
 * No mock transport, direct readWorkspace invocation, browser or model call. */
test('Files/Diff HTTP API → commands → full daemon → receipt → HTTP response on PostgreSQL 17', { skip: !databaseURL, timeout: 180_000 }, async t => {
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
  const deliveries: Array<{ id: string; runId: string; repoId: string; kind: string; path?: string }> = []
  const receipts: Array<{ requestId: string; status: number; body: WorkspaceReadReceipt }> = []
  const receiptEvents = new Map<string, PromiseWithResolvers<void>>()
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
      route('/api/runs/[runId]/workspace/diff', ['GET'], () => import('../../app/api/runs/[runId]/workspace/diff/route')),
      route('/api/runs/[runId]/workspace/diff/[snapshotId]/file', ['GET'], () => import('../../app/api/runs/[runId]/workspace/diff/[snapshotId]/file/route')),
      route('/api/runs/[runId]/workspace/diff/[snapshotId]/review', ['GET', 'POST'], () => import('../../app/api/runs/[runId]/workspace/diff/[snapshotId]/review/route')),
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
    await writeFile(join(worktree, 'src/lazy.ts'), 'export const lazy = "base"\n')
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
      const mutateReview = (snapshotId: string, mutation: ReviewMutation) => fetch(`${endpoint}/diff/${snapshotId}/review`, {
        method: 'POST', headers: { authorization: `Bearer ${ownerToken.token}`, origin, 'content-type': 'application/json' },
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
      assert.equal(response.status, 200, JSON.stringify(traffic))
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
      assert.equal(fileResponse.status, 200, JSON.stringify(traffic))
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
      assert.equal((await getReview(snapshot.id, memberToken.token)).status, 404)
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM coding_workspace_review_receipts WHERE "requestId"=$1', [firstInput.requestId])).rows[0].n, 1)

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
      assert.equal(freshResponse.status, 200)
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
