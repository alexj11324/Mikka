import assert from 'node:assert/strict'
import test from 'node:test'
const previousBase = process.env.MIKKA_BASE_PATH
process.env.MIKKA_BASE_PATH = '/mikka'
const {
  driveFileURL, driveHeadKey, driveHistoryKey, driveVolumesKey, DriveRequestError,
  readDriveFileHistory, readDriveVolumes, restoreDriveVersion, uploadDriveFiles,
} = await import('./client')
if (previousBase === undefined) delete process.env.MIKKA_BASE_PATH
else process.env.MIKKA_BASE_PATH = previousBase

test('file links and caches distinguish the selected tenant, account and immutable version', () => {
  const url = new URL(driveFileURL('workspace-a', 'volume', 'a b/#notes.md', 'version-1'), 'https://example.invalid')
  assert.equal(url.pathname, '/mikka/api/drive/volumes/volume/files')
  assert.equal(url.searchParams.get('workspaceId'), 'workspace-a')
  assert.equal(url.searchParams.get('path'), 'a b/#notes.md')
  assert.equal(url.searchParams.get('versionId'), 'version-1')
  for (const key of [driveVolumesKey, driveHeadKey, driveHistoryKey]) {
    assert.notDeepEqual(key('workspace-a', 'owner-a', 'volume'), key('workspace-b', 'owner-a', 'volume'))
    assert.notDeepEqual(key('workspace-a', 'owner-a', 'volume'), key('workspace-a', 'owner-b', 'volume'))
  }
})

test('an upload sends actual bytes before publishing one atomic manifest change', async () => {
  const calls: { url: URL; init: RequestInit }[] = []
  const file = new File(['saved content'], 'result.txt', { type: 'text/plain' })
  const send: typeof fetch = async (target, init) => {
    calls.push({ url: new URL(String(target), 'https://example.invalid'), init: init! })
    return Response.json(calls.length === 1 ? { sha256: 'a'.repeat(64), sizeBytes: file.size } : { headDigest: 'b'.repeat(64), headVersionId: 'version-2' })
  }
  await uploadDriveFiles('workspace-a', 'volume', 'old-digest', [file], 'mutation-1', send)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].url.pathname.endsWith('/blobs'), true)
  assert.equal(await (calls[0].init.body as File).text(), 'saved content')
  assert.equal(calls[1].init.method, 'PATCH')
  assert.deepEqual(JSON.parse(calls[1].init.body as string), {
    expectedDigest: 'old-digest', mutationId: 'mutation-1',
    changes: [{ op: 'put', path: 'result.txt', mode: 420, sha256: 'a'.repeat(64), sizeBytes: file.size }],
  })
  for (const call of calls) {
    assert.equal(call.url.searchParams.get('workspaceId'), 'workspace-a')
    assert.equal(call.init.cache, 'no-store')
    assert.equal(call.init.credentials, 'same-origin')
  }
})

test('a rejected blob upload cannot publish a manifest or retry itself', async () => {
  let calls = 0
  const send: typeof fetch = async () => { calls++; return Response.json({ error: 'authRequired' }, { status: 401 }) }
  await assert.rejects(uploadDriveFiles('workspace-a', 'volume', 'old-digest', [new File(['secret'], 'notes.txt')], 'mutation-1', send),
    (error: unknown) => error instanceof DriveRequestError && error.status === 401 && error.code === 'authRequired')
  assert.equal(calls, 1)
})

test('restore sends the selected immutable version and observed current digest; conflicts are preserved', async () => {
  let seen: RequestInit | undefined, target: URL | undefined
  const send: typeof fetch = async (input, init) => {
    target = new URL(String(input), 'https://example.invalid'); seen = init
    return Response.json({ error: 'drive_head_conflict', headDigest: 'new-head' }, { status: 409 })
  }
  await assert.rejects(restoreDriveVersion('workspace-a', 'volume', 'version-1', 'old-head', 'restore-1', send),
    (error: unknown) => error instanceof DriveRequestError && error.status === 409)
  assert.equal(target?.searchParams.get('workspaceId'), 'workspace-a')
  assert.deepEqual(JSON.parse(seen?.body as string), { versionId: 'version-1', expectedDigest: 'old-head', mutationId: 'restore-1' })
})

test('transport failures keep their cause and do not become an empty file listing', async () => {
  const cause = new Error('synthetic transport')
  await assert.rejects(readDriveVolumes('workspace-a', undefined, async () => { throw cause }),
    (error: unknown) => error instanceof DriveRequestError && error.cause === cause)
})

test('the file history reader preserves literal path characters, cursor and workspace scope', async () => {
  const path = 'notes/a & + #%.md'
  const page = await readDriveFileHistory('workspace-a', 'folder', path, 'cursor', async (input, init) => {
    const url = new URL(String(input), 'https://example.invalid')
    assert.equal(url.pathname, '/mikka/api/drive/volumes/folder/versions')
    assert.deepEqual(Object.fromEntries(url.searchParams), { workspaceId: 'workspace-a', path, before: 'cursor' })
    assert.equal(init?.credentials, 'same-origin')
    return Response.json({ versions: [], nextCursor: null })
  })
  assert.deepEqual(page, { versions: [], nextCursor: null })
})
