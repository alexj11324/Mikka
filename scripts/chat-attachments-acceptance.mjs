// API acceptance of private chat files against an attested, runner-owned local build.
// Uses the normal account lease and auth routes; no browser interaction tests.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { Pool } from 'pg'
import { binaryAttachmentFixtures } from './chat-attachments-fixtures.mjs'
import { acquireTestAccounts } from './test-accounts/session.mjs'
import { TestAccountPool } from './test-accounts/pool.mjs'
import { loadEnvironment } from './test-accounts/environment.mjs'

const fingerprint = async () => {
  const paths = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'app',
      'components',
      'lib',
      'packages',
      'scripts',
      'messages',
      'drizzle',
      'package.json',
      'pnpm-lock.yaml',
    ],
    { encoding: 'utf8' },
  )
    .split('\0')
    .filter(Boolean)
    .sort()
  const hash = createHash('sha256')
  for (const path of paths) {
    hash.update(`${path}\0`)
    hash.update(await readFile(path))
  }
  return hash.digest('hex')
}
const sourceFingerprint = await fingerprint()
const environment = await loadEnvironment()
assert.ok(['localhost', '127.0.0.1'].includes(new URL(environment.origin).hostname))
const database = new Pool({ connectionString: process.env.E2E_DATABASE_URL, max: 3 })
await new TestAccountPool(database, environment).prepare({ pairs: 8 })
const accounts = await acquireTestAccounts({
  database,
  environment,
  runId: randomUUID(),
  workerId: 'chat-attachments',
  requestId: randomUUID(),
})
const evidence = '.cache/attachments/api-evidence.json'
const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
const checks = []
const assertStatus = async (response, expected) => {
  assert.equal(
    response.status,
    expected,
    `HTTP ${response.status}, expected ${expected}: ${response.status === expected ? '' : await response.text()}`,
  )
  return response
}
try {
  const owner = accounts.owner
  for (const route of ['sign-in', 'sign-up']) {
    const response = await owner.request(
      `/mikka/${route}?next=${encodeURIComponent('/api/integrations/composio/callback')}`,
    )
    assert.ok([200, 307].includes(response.status))
    const destination =
      response.headers.get('location') ??
      /<meta[^>]+id="__next-page-redirect"[^>]+content="[^"]*?url=([^"]+)"/.exec(await response.text())?.[1]
    assert.ok(destination, 'server navigation provides an HTTP or streaming redirect')
    assert.equal(
      new URL(destination, environment.origin).pathname,
      '/mikka/api/integrations/composio/callback',
    )
  }
  checks.push('signed-in redirect targets use the base path once')
  const bot = (
    await database.query(
      'SELECT b.id,b."workspaceId" FROM coordinator_bots cb JOIN bots b ON b.id=cb."botId" WHERE cb."ownerId"=$1',
      [owner.userId],
    )
  ).rows[0]
  assert.ok(bot)
  const scope = { kind: 'bot', id: bot.id }
  const uploaded = []
  for (const [name, contents, expectedText] of [
    [
      'Mikka_2026_产品功能与接口说明_最终修订稿_这是一个很长的文件名.md',
      '# Markdown 原文\n\n```ts\nconst answer = 42\n```\n',
    ],
    ['销售数据.csv', '日期,产品,收入\n2026-11-03,Mikka,1250\n'],
    ['数据结构.json', '{"project":"Mikka","version":3}'],
    ['说明.txt', '中文内容保持完整。'],
    ...(await binaryAttachmentFixtures()),
  ]) {
    const bytes = Buffer.from(contents)
    const started = await (
      await assertStatus(
        await owner.request(
          '/api/chat/attachments',
          json({ operation: 'init', scope, name, size: bytes.length, mediaType: 'application/octet-stream' }),
        ),
        200,
      )
    ).json()
    assert.equal(started.uploadUrl, undefined, 'This acceptance owns the isolated inline storage adapter')
    assert.equal(started.chunkSize, 3 * 1024 * 1024)
    for (let part = 0; part < Math.ceil(bytes.length / started.chunkSize); part++) {
      const body = bytes.subarray(part * started.chunkSize, (part + 1) * started.chunkSize)
      const response = await assertStatus(
        await owner.request(`/api/chat/attachments?id=${started.id}&part=${part}`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body,
        }),
        200,
      )
      assert.equal((await response.json()).received, Math.min((part + 1) * started.chunkSize, bytes.length))
    }
    const file = await (
      await assertStatus(
        await owner.request('/api/chat/attachments', json({ operation: 'complete', id: started.id })),
        200,
      )
    ).json()
    assert.equal(file.id, started.id)
    const retried = await (
      await assertStatus(
        await owner.request('/api/chat/attachments', json({ operation: 'complete', id: file.id })),
        200,
      )
    ).json()
    assert.deepEqual(retried, file)
    const response = await assertStatus(await owner.request(`/api/chat/attachments/${file.id}?download`), 200)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
    assert.match(response.headers.get('content-disposition'), /attachment/)
    await assertStatus(await accounts.peer.request(`/api/chat/attachments/${file.id}`), 404)
    if (expectedText) {
      const row = (await database.query('SELECT "textContent" FROM chat_attachments WHERE id=$1', [file.id]))
        .rows[0]
      assert.ok(
        row.textContent.includes(expectedText),
        `${name}: parsed content absent in the production build`,
      )
    }
    uploaded.push(file)
  }
  checks.push(
    'normal signup/session lease',
    'real bytes and original filenames',
    'idempotent completion',
    'authenticated downloads',
    'foreign account denied',
    'production Word, spreadsheet, PDF, RTF and PNG processing',
    'same-origin chunk upload of an image larger than 4.5 MiB',
  )
  const text =
    uploaded.map((file) => `[mikka-file:${file.id}:${encodeURIComponent(file.name)}]`).join('\n') +
    '\n\n对照这些资料检查实现'
  const submissionId = randomUUID()
  for (let attempt = 0; attempt < 2; attempt++)
    await assertStatus(await owner.request('/api/coordinator/messages', json({ text, submissionId })), 202)
  assert.equal(
    (
      await database.query(
        `SELECT count(*)::int AS n FROM coordinator_events WHERE "userId"=$1 AND payload->>'text'=$2`,
        [owner.userId, text],
      )
    ).rows[0].n,
    1,
  )
  const chat = await (await assertStatus(await owner.request('/api/mobile/chat'), 200)).json()
  assert.ok(JSON.stringify(chat).includes(uploaded[0].id))
  await assertStatus(
    await owner.request(`/api/chat/attachments/${uploaded[0].id}`, { method: 'DELETE' }),
    200,
  )
  await assertStatus(await owner.request(`/api/chat/attachments/${uploaded[0].id}?info`), 200)
  checks.push('real Bot send and immutable resend', 'history survives removing a reused draft')
  const group = await (
    await assertStatus(
      await owner.request(
        '/api/conversations',
        json({ workspaceId: bot.workspaceId, title: '附件验收', members: [] }),
      ),
      201,
    )
  ).json()
  const bytes = Buffer.from('# 群聊附件\n分组文件应可读。')
  const initialized = await (
    await assertStatus(
      await owner.request(
        '/api/chat/attachments',
        json({
          operation: 'init',
          scope: { kind: 'group', id: group.id },
          name: '群聊资料.md',
          size: bytes.length,
          mediaType: 'text/markdown',
        }),
      ),
      200,
    )
  ).json()
  const groupFile = await (
    await assertStatus(
      await owner.request(`/api/chat/attachments?id=${initialized.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      }),
      200,
    )
  ).json()
  await assertStatus(
    await owner.request(
      `/api/conversations/${group.id}/messages`,
      json({ body: `[mikka-file:${groupFile.id}:${encodeURIComponent(groupFile.name)}]` }),
    ),
    201,
  )
  checks.push('real group attachment-only send')
  const { seedAgent, seedRun } = await import('../tests/support/workspace-admin-db.ts')
  const agentId = await seedAgent(database, owner.userId)
  const runId = await seedRun(database, { userId: owner.userId, agentId, botId: bot.id, status: 'running' })
  const threadUpload = await (
    await assertStatus(
      await owner.request(
        '/api/chat/attachments',
        json({
          operation: 'init',
          scope: { kind: 'thread', id: runId },
          name: 'Agent.md',
          size: bytes.length,
          mediaType: 'text/markdown',
        }),
      ),
      200,
    )
  ).json()
  const threadFile = await (
    await assertStatus(
      await owner.request(`/api/chat/attachments?id=${threadUpload.id}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: bytes,
      }),
      200,
    )
  ).json()
  await assertStatus(
    await owner.request(
      `/api/mobile/threads/${runId}`,
      json({ text: `[mikka-file:${threadFile.id}:${encodeURIComponent(threadFile.name)}]` }),
    ),
    202,
  )
  assert.ok(
    (await database.query('SELECT text FROM run_messages WHERE "runId"=$1', [runId])).rows.some((row) =>
      row.text.includes(threadFile.id),
    ),
  )
  checks.push('real live Agent thread attachment-only input')
  await mkdir('.cache/attachments', { recursive: true, mode: 0o700 })
  // Private state is used only for screenshot setup; never copied into public evidence.
  await writeFile(
    '.cache/attachments/visual-fixture.json',
    JSON.stringify({
      origin: environment.origin,
      statePath: owner.storageStatePath,
      userId: owner.userId,
      botId: bot.id,
      groupId: group.id,
      runId,
      draft:
        uploaded
          .slice(0, 4)
          .map((file) => `[mikka-file:${file.id}:${encodeURIComponent(file.name)}]`)
          .join('\n') + '\n\n对照这些资料检查实现',
    }),
    { mode: 0o600 },
  )
  await writeFile(
    evidence,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        revision: environment.deploymentSha,
        origin: environment.origin,
        database: environment.database.name,
        checks,
        sourceFingerprint,
        externalModel: 'not invoked',
        daemonDownload: 'separate PostgreSQL and materialization tests',
      },
      null,
      2,
    ),
  )
  console.log(JSON.stringify({ passed: checks.length, evidence }))
  // Screenshot capture happens while this lease remains live.
  if (process.env.CHAT_FILE_SCREENSHOTS === '1') {
    const { spawn } = await import('node:child_process')
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['scripts/chat-attachments-screenshots.mjs'], {
        stdio: 'inherit',
        env: process.env,
      })
      child.once('exit', (code) => (code === 0 ? resolve() : reject(Error('Screenshot capture failed'))))
    })
  }
  assert.equal(await fingerprint(), sourceFingerprint, 'Source changed during acceptance')
} finally {
  await accounts.release({ outcome: 'dirty' })
  await database.end()
}
