import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { linkSync, mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  WORKSPACE_MAX_FILE_BYTES, WORKSPACE_MAX_PATHS, WORKSPACE_MAX_RESPONSE_BYTES,
  matchesWorkspaceResponse, workspaceReadReceipt, workspaceReadRequest, workspaceReadResult,
  type RunWorktreeIdentity, type WorkspaceReadCommand, type WorkspaceReadResult,
} from '@mikka/protocol/coding-workspace'
import { remoteKey } from '@mikka/protocol/repository'
import { readWorkspace, readWorkspaceReceipt } from '../src/coding-workspace/files'
import { RunJournal } from '../src/runs/journal'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

const remote = 'https://github.com/mikka-fixtures/coding-workspace.git'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

async function makeFixture() {
  const repository = await makeRepo()
  git(repository, 'remote', 'add', 'origin', remote)
  const directory = tempDir('mikka-workspace-')
  const root = join(directory, 'checkout')
  git(repository, 'worktree', 'add', '-q', '--detach', root, 'HEAD')
  const headSha = git(root, 'rev-parse', 'HEAD')
  const identity: RunWorktreeIdentity = {
    version: 1, runId: randomUUID(), repoId: randomUUID(), deviceId: randomUUID(),
    workspaceId: randomUUID(), ownerId: 'workspace-file-test-owner',
    repositoryKey: remoteKey(remote)!, bindingId: digest('fixture-binding'),
  }
  const file = join(directory, 'journal.json')
  new RunJournal(file).put({
    assignment: { runId: identity.runId, issueId: randomUUID(), repoId: identity.repoId,
      deviceId: identity.deviceId, remoteUrl: remote, baseBranch: 'main', harness: 'mock', prompt: 'Read workspace files' },
    state: 'running', sessionId: null, worktree: root, baseCommit: headSha,
    lastSeq: 0, error: null, updatedAt: new Date().toISOString(),
  })
  // Exercise the persisted local authority rather than an invented request root.
  const journal = new RunJournal(file)
  const entry = journal.get(identity.runId)!
  const command = (request: unknown): WorkspaceReadCommand => ({
    id: randomUUID(), identity, request: workspaceReadRequest.parse(request),
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
  })
  const read = async (request: unknown) => {
    const input = command(request)
    const result = workspaceReadResult.parse(await readWorkspace(input, entry))
    expect(matchesWorkspaceResponse(input.request, identity, result)).toBe(true)
    return result
  }
  const write = (path: string, value: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  return { repository, directory, root, identity, entry, headSha, command, read, write }
}

function success<K extends 'file' | 'tree' | 'search' | 'context'>(result: WorkspaceReadResult, kind: K) {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, kind })
  if (!result.ok || result.kind !== kind) throw new Error(`Expected successful ${kind} response`)
  return result as Extract<WorkspaceReadResult, { kind: K }>
}

afterEach(() => {
  vi.restoreAllMocks()
  cleanupTempDirs()
})

describe.skipIf(process.platform !== 'linux')('coding workspace files on a real Run worktree', () => {
  let fixture: Awaited<ReturnType<typeof makeFixture>>
  beforeEach(async () => { fixture = await makeFixture() })

  it('reads the journal worktree, including uncommitted UTF-8, with a content-bound observation', async () => {
    fixture.write('src/你好.ts', 'const greeting = "你好 🌱"\r\nexport { greeting }\r\n')
    const result = success(await fixture.read({ kind: 'file', path: 'src/你好.ts' }), 'file')
    expect(result).toMatchObject({
      identity: fixture.identity, availability: 'online', format: 'text', language: 'ts', editable: false,
      content: 'const greeting = "你好 🌱"\r\nexport { greeting }\r\n',
      contentSha256: digest('const greeting = "你好 🌱"\r\nexport { greeting }\r\n'),
      startLine: 1, endLine: 3, totalLines: 3, truncated: false,
      revision: { source: 'working', headSha: fixture.headSha, baseSha: fixture.headSha },
    })
    expect(Number.isFinite(Date.parse(result.observedAt))).toBe(true)
    expect(result.size).toBe(Buffer.byteLength(result.content!))
    fixture.write('src/你好.ts', 'changed live\n')
    const changed = success(await fixture.read({ kind: 'file', path: 'src/你好.ts' }), 'file')
    expect(changed.content).toBe('changed live\n')
    expect(changed.revision.version).not.toBe(result.revision.version)
  })

  it('preserves a UTF-8 BOM in both the content and the full-file hash', async () => {
    const contents = '\uFEFFfirst line\r\nsecond line\r\n'
    fixture.write('bom.txt', contents)
    const file = success(await fixture.read({ kind: 'file', path: 'bom.txt' }), 'file')
    expect(file).toMatchObject({ format: 'text', content: contents, contentSha256: digest(contents), size: Buffer.byteLength(contents) })
    const range = success(await fixture.read({ kind: 'file', path: 'bom.txt', range: { startLine: 2, endLine: 2 } }), 'file')
    expect(range).toMatchObject({ content: 'second line\r', contentSha256: digest(contents), startLine: 2, endLine: 2 })
  })

  it('sends complete, byte-exact private proof for a range and keeps it out of the public facade', async () => {
    const contents = Buffer.from('\uFEFFfixture-first-secret-line\r\nfixture-second-secret-line\r\n')
    fixture.write('proof.txt', contents)
    const command = fixture.command({ kind: 'file', path: 'proof.txt', range: { startLine: 2, endLine: 2 } })
    const receipt = workspaceReadReceipt.parse(await readWorkspaceReceipt(command, fixture.entry))
    expect(success(receipt.result, 'file')).toMatchObject({ content: 'fixture-second-secret-line\r', contentSha256: digest(contents) })
    expect(receipt.files).toEqual([{ path: 'proof.txt', base64: contents.toString('base64') }])
    expect(Buffer.from(receipt.files[0]!.base64, 'base64')).toEqual(contents)
    const publicResult = await fixture.read(command.request)
    expect(publicResult).not.toHaveProperty('files')
    expect(JSON.stringify(publicResult)).not.toContain(contents.toString('base64'))
    expect(JSON.stringify(publicResult)).not.toContain('fixture-first-secret-line')
  })

  it('deduplicates whole-file proof when two selected ranges refer to one file', async () => {
    const contents = 'first\nsecond\nthird\n'
    fixture.write('proof.txt', contents)
    const receipt = workspaceReadReceipt.parse(await readWorkspaceReceipt(fixture.command({
      kind: 'context', selection: { kind: 'resolved', files: [
        { path: 'proof.txt', range: { startLine: 1, endLine: 1 } },
        { path: 'proof.txt', range: { startLine: 3, endLine: 3 } },
      ] },
    }), fixture.entry))
    expect(success(receipt.result, 'context').files.map(file => file.content)).toEqual(['first', 'third'])
    expect(receipt.files).toEqual([{ path: 'proof.txt', base64: Buffer.from(contents).toString('base64') }])
  })

  it('includes an explicit empty proof for empty text', async () => {
    fixture.write('empty.txt', '')
    const receipt = workspaceReadReceipt.parse(await readWorkspaceReceipt(fixture.command({ kind: 'file', path: 'empty.txt' }), fixture.entry))
    expect(success(receipt.result, 'file')).toMatchObject({ content: '', size: 0, contentSha256: digest('') })
    expect(receipt.files).toEqual([{ path: 'empty.txt', base64: '' }])
  })

  it('bounds aggregate proof bytes even when the selected ranges themselves are tiny', async () => {
    for (const path of ['proof-a.txt', 'proof-b.txt']) fixture.write(path, 'short\n' + 'a'.repeat(600 * 1024))
    const receipt = workspaceReadReceipt.parse(await readWorkspaceReceipt(fixture.command({
      kind: 'context', selection: { kind: 'resolved', files: [
        { path: 'proof-a.txt', range: { startLine: 1, endLine: 1 } },
        { path: 'proof-b.txt', range: { startLine: 1, endLine: 1 } },
      ] },
    }), fixture.entry))
    expect(receipt).toEqual({ result: { ok: false, code: 'workspace_limit_exceeded' }, files: [] })
  })

  it('accepts the exact 1 MiB proof boundary and counts a repeated file only once', async () => {
    const contents = Buffer.from('x\n' + 'a'.repeat(WORKSPACE_MAX_FILE_BYTES - 2))
    fixture.write('boundary.txt', contents)
    const selection = { path: 'boundary.txt', range: { startLine: 1, endLine: 1 } }
    const receipt = workspaceReadReceipt.parse(await readWorkspaceReceipt(fixture.command({
      kind: 'context', selection: { kind: 'resolved', files: [selection, selection] },
    }), fixture.entry))
    expect(success(receipt.result, 'context').files.map(file => file.content)).toEqual(['x', 'x'])
    expect(receipt.files).toHaveLength(1)
    expect(Buffer.from(receipt.files[0]!.base64, 'base64')).toEqual(contents)
  })

  it('does not return partial proof after a later context member fails', async () => {
    fixture.write('available.txt', 'readable first member')
    const receipt = workspaceReadReceipt.parse(await readWorkspaceReceipt(fixture.command({
      kind: 'context', selection: { kind: 'resolved', files: [{ path: 'available.txt' }, { path: 'missing.txt' }] },
    }), fixture.entry))
    expect(receipt).toEqual({ result: { ok: false, code: 'workspace_path_unavailable' }, files: [] })
  })

  it('keeps binary, unsupported and oversized metadata receipts free of file bytes', async () => {
    for (const [path, contents] of [
      ['binary.txt', Buffer.from([0xff])],
      ['unsupported.data', Buffer.from('opaque fixture')],
      ['oversized.txt', Buffer.alloc(WORKSPACE_MAX_FILE_BYTES + 1, 0x61)],
    ] as const) {
      fixture.write(path, contents)
      const receipt = workspaceReadReceipt.parse(await readWorkspaceReceipt(fixture.command({ kind: 'file', path }), fixture.entry))
      expect(success(receipt.result, 'file').content).toBeNull()
      expect(receipt.files).toEqual([])
    }
  })

  it('lists immediate children, sizes, and safe dotfiles and searches paths case-insensitively', async () => {
    fixture.write('src/deep/Alpha.ts', 'alpha\n')
    fixture.write('src/beta.ts', 'beta\n')
    fixture.write('.github/workflows/test.yml', 'name: test\n')
    fixture.write('.env', 'DO_NOT_RETURN=fixture-secret\n')
    const tree = success(await fixture.read({ kind: 'tree', path: 'src' }), 'tree')
    expect(tree.entries).toEqual([
      { path: 'src/deep', name: 'deep', kind: 'directory', size: null },
      { path: 'src/beta.ts', name: 'beta.ts', kind: 'file', size: 5 },
    ])
    const root = success(await fixture.read({ kind: 'tree' }), 'tree')
    expect(root.entries.some(entry => entry.path === '.github')).toBe(true)
    expect(root.entries.some(entry => entry.path === '.gitignore')).toBe(true)
    expect(root.entries.some(entry => entry.path === '.env')).toBe(false)
    const search = success(await fixture.read({ kind: 'search', query: 'DEEP/ALPHA' }), 'search')
    expect(search.entries).toEqual([{ path: 'src/deep/Alpha.ts', name: 'Alpha.ts', kind: 'file', size: 6 }])
  })

  it('excludes ignored untracked files while retaining explicitly tracked ordinary files', async () => {
    fixture.write('.gitignore', '.env.local\nignored/\n*.cache.txt\n')
    fixture.write('ignored/generated.ts', 'not in the inventory')
    fixture.write('build.cache.txt', 'not in the inventory either')
    fixture.write('tracked.cache.txt', 'intentionally tracked')
    git(fixture.root, 'add', '-f', '--', 'tracked.cache.txt')
    for (const path of ['ignored/generated.ts', 'build.cache.txt']) {
      expect(await fixture.read({ kind: 'file', path })).toEqual({ ok: false, code: 'workspace_path_unavailable' })
      expect(success(await fixture.read({ kind: 'search', query: path }), 'search').entries).toEqual([])
    }
    const tree = success(await fixture.read({ kind: 'tree' }), 'tree')
    expect(tree.entries.some(entry => entry.path === 'ignored')).toBe(false)
    expect(success(await fixture.read({ kind: 'file', path: 'tracked.cache.txt' }), 'file').content).toBe('intentionally tracked')
  })

  it('enforces the inventory limit against more than 20,000 real Git index paths', async () => {
    const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: fixture.root, encoding: 'utf8', input: 'indexed fixture\n',
    }).trim()
    // Real index records exercise Git's inventory without materializing 20,001
    // redundant files; the limit must apply before any path is opened.
    const index = Array.from({ length: WORKSPACE_MAX_PATHS + 1 }, (_, number) => `100644 ${blob}\tindexed/${number}.txt`).join('\n') + '\n'
    execFileSync('git', ['update-index', '--index-info'], { cwd: fixture.root, input: index })
    expect(await fixture.read({ kind: 'tree' })).toEqual({ ok: false, code: 'workspace_limit_exceeded' })
    expect(await fixture.read({ kind: 'search', query: 'indexed/' })).toEqual({ ok: false, code: 'workspace_limit_exceeded' })
  })

  it('paginates a stable tree without duplicates and rejects a cursor after its inventory changes', async () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']) fixture.write(`page/${name}`, name)
    const first = success(await fixture.read({ kind: 'tree', path: 'page', limit: 2 }), 'tree')
    expect(first.truncated).toBe(true)
    const second = success(await fixture.read({ kind: 'tree', path: 'page', limit: 2, cursor: first.nextCursor }), 'tree')
    const third = success(await fixture.read({ kind: 'tree', path: 'page', limit: 2, cursor: second.nextCursor }), 'tree')
    expect([...first.entries, ...second.entries, ...third.entries].map(entry => entry.path)).toEqual([
      'page/a.ts', 'page/b.ts', 'page/c.ts', 'page/d.ts', 'page/e.ts',
    ])
    expect(third).toMatchObject({ truncated: false, nextCursor: null })
    fixture.write('page/f.ts', 'new')
    expect(await fixture.read({ kind: 'tree', path: 'page', limit: 2, cursor: first.nextCursor }))
      .toEqual({ ok: false, code: 'workspace_version_conflict' })
  })

  it('bounds search results and fails closed for an invalid or out-of-range cursor', async () => {
    for (const name of ['a.ts', 'b.ts', 'c.ts']) fixture.write(`find/${name}`, name)
    const search = success(await fixture.read({ kind: 'search', query: 'find/', limit: 2 }), 'search')
    expect(search).toMatchObject({ truncated: true })
    expect(search.entries).toHaveLength(2)
    const tree = success(await fixture.read({ kind: 'tree', path: 'find', limit: 1 }), 'tree')
    expect(await fixture.read({ kind: 'tree', path: 'find', cursor: 'invalid' }))
      .toEqual({ ok: false, code: 'workspace_version_conflict' })
    expect(await fixture.read({ kind: 'tree', path: 'find', cursor: `${tree.revision.version}:999` }))
      .toEqual({ ok: false, code: 'workspace_invalid_request' })
  })

  it('supports ranges past line 2000, empty final lines, and the default line limit', async () => {
    fixture.write('long.txt', Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join('\n') + '\n')
    const first = success(await fixture.read({ kind: 'file', path: 'long.txt' }), 'file')
    expect(first).toMatchObject({ startLine: 1, endLine: 2000, totalLines: 2501, truncated: true })
    const next = success(await fixture.read({ kind: 'file', path: 'long.txt', range: { startLine: 2001, endLine: 2500 } }), 'file')
    expect(next).toMatchObject({ startLine: 2001, endLine: 2500, totalLines: 2501, truncated: true })
    expect(next.content!.split('\n')).toHaveLength(500)
    expect(next.content).toMatch(/^line 2001\n/)
    const last = success(await fixture.read({ kind: 'file', path: 'long.txt', range: { startLine: 2501, endLine: 2501 } }), 'file')
    expect(last).toMatchObject({ content: '', startLine: 2501, endLine: 2501, totalLines: 2501 })
    expect(await fixture.read({ kind: 'file', path: 'long.txt', range: { startLine: 2502, endLine: 2502 } }))
      .toEqual({ ok: false, code: 'workspace_invalid_request' })
  })

  it('counts UTF-8 bytes once, truncates at a complete line, and rejects an oversized single line', async () => {
    const line = '界'.repeat(30_000)
    fixture.write('budget.txt', [line, line, line, 'tail'].join('\n'))
    const result = success(await fixture.read({ kind: 'file', path: 'budget.txt' }), 'file')
    expect(result).toMatchObject({ content: `${line}\n${line}`, endLine: 2, totalLines: 4, truncated: true })
    expect(Buffer.byteLength(result.content!)).toBeLessThanOrEqual(WORKSPACE_MAX_RESPONSE_BYTES)
    fixture.write('single.txt', 'a'.repeat(WORKSPACE_MAX_RESPONSE_BYTES + 1))
    expect(await fixture.read({ kind: 'file', path: 'single.txt' }))
      .toEqual({ ok: false, code: 'workspace_limit_exceeded' })
  })

  it.each([
    ['zero.txt', Buffer.from(''), 'text'],
    ['nul.txt', Buffer.from('one\0two'), 'binary'],
    ['invalid.txt', Buffer.from([0xff, 0xfe, 0x61]), 'binary'],
    ['image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'binary'],
    ['opaque.data', Buffer.from('valid UTF-8 but unknown format'), 'unsupported'],
    ['large.txt', Buffer.alloc(WORKSPACE_MAX_FILE_BYTES + 1, 0x61), 'too_large'],
  ] as const)('returns bounded metadata for %s', async (path, bytes, format) => {
    fixture.write(path, bytes)
    const result = success(await fixture.read({ kind: 'file', path }), 'file')
    expect(result).toMatchObject({ path, format, size: bytes.length, editable: false })
    expect(result.content).toBe(format === 'text' ? '' : null)
    expect(result.contentSha256).toBe(format === 'too_large' ? null : digest(bytes))
  })

  it.each(['.env', '.env.production', '.git/config', '.npmrc', '.ssh/id_rsa', 'secrets.json', 'credentials.txt', 'cert/private.pem', '.codex/auth.json'])
    ('refuses protected path %s, including tracked secret files', async path => {
      if (path !== '.git/config') {
        fixture.write(path, 'fixture-secret-never-returned')
        git(fixture.root, 'add', '-f', '--', path)
      }
      expect(await fixture.read({ kind: 'file', path })).toEqual({ ok: false, code: 'workspace_path_unavailable' })
      const search = success(await fixture.read({ kind: 'search', query: path }), 'search')
      expect(search.entries).toEqual([])
    })

  it.each(['../outside.txt', '/etc/passwd', 'C:/secret.txt', 'src\\secret.txt', 'src/../README.md', 'src//x.ts', 'src/./x.ts', 'bad\0name.txt'])
    ('rejects invalid path syntax %j before touching a checkout', async path => {
      const command = fixture.command({ kind: 'file', path: 'README.md' })
      command.request = { kind: 'file', path }
      expect(await readWorkspace(command, fixture.entry)).toEqual({ ok: false, code: 'workspace_invalid_request' })
    })

  it('treats percent escapes as literal filename characters', async () => {
    fixture.write('%2e%2e/literal.txt', 'inside this worktree')
    expect(success(await fixture.read({ kind: 'file', path: '%2e%2e/literal.txt' }), 'file').content).toBe('inside this worktree')
    expect(await fixture.read({ kind: 'file', path: '%2e%2e%2foutside.txt' })).toEqual({ ok: false, code: 'workspace_path_unavailable' })
  })

  it('never follows file, parent-directory, or tracked symlinks or reads a hardlink', async () => {
    const outside = join(fixture.directory, 'outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.txt'), 'outside-fixture-secret')
    fixture.write('safe.txt', 'safe contents')
    symlinkSync(join(outside, 'secret.txt'), join(fixture.root, 'external.txt'))
    symlinkSync('safe.txt', join(fixture.root, 'internal.txt'))
    fixture.write('parent/secret.txt', 'original')
    git(fixture.root, 'add', '--', 'external.txt', 'internal.txt', 'parent/secret.txt')
    rmSync(join(fixture.root, 'parent'), { recursive: true })
    symlinkSync(outside, join(fixture.root, 'parent'), 'dir')
    linkSync(join(outside, 'secret.txt'), join(fixture.root, 'hardlink.txt'))
    for (const path of ['external.txt', 'internal.txt', 'parent/secret.txt', 'hardlink.txt']) {
      expect(await fixture.read({ kind: 'file', path })).toEqual({ ok: false, code: 'workspace_path_unavailable' })
    }
    const tree = success(await fixture.read({ kind: 'tree' }), 'tree')
    for (const path of ['external.txt', 'internal.txt', 'hardlink.txt']) {
      expect(tree.entries.find(entry => entry.path === path)).toMatchObject({ kind: 'file', size: null })
    }
    expect(JSON.stringify(tree)).not.toContain('outside-fixture-secret')
  })

  it.each(['runId', 'repoId', 'deviceId'] as const)('rejects a command whose %s does not match the persisted journal', async field => {
    const command = fixture.command({ kind: 'file', path: 'README.md' })
    command.identity = { ...command.identity, [field]: randomUUID() }
    expect(await readWorkspace(command, fixture.entry)).toEqual({ ok: false, code: 'workspace_checkout_unavailable' })
  })

  it('rejects a changed canonical repository, missing journal, missing checkout, and symlink checkout root', async () => {
    const command = fixture.command({ kind: 'file', path: 'README.md' })
    expect(await readWorkspace(command, undefined)).toEqual({ ok: false, code: 'workspace_checkout_unavailable' })
    expect(await readWorkspace(command, { ...fixture.entry, worktree: null })).toEqual({ ok: false, code: 'workspace_checkout_unavailable' })
    const linkedRoot = join(fixture.directory, 'linked-checkout')
    symlinkSync(fixture.root, linkedRoot, 'dir')
    expect(await readWorkspace(command, { ...fixture.entry, worktree: linkedRoot })).toEqual({ ok: false, code: 'workspace_checkout_unavailable' })
    expect(await readWorkspace({ ...command, identity: { ...command.identity, repositoryKey: 'github.com/another/repository' } }, fixture.entry))
      .toEqual({ ok: false, code: 'workspace_checkout_unavailable' })
    git(fixture.root, 'remote', 'set-url', 'origin', 'https://github.com/mikka-fixtures/another-repository.git')
    expect(await readWorkspace(command, fixture.entry)).toEqual({ ok: false, code: 'workspace_checkout_unavailable' })
  })

  it('rejects expired requests and unexpected external-root fields', async () => {
    const command = fixture.command({ kind: 'file', path: 'README.md' })
    expect(await readWorkspace({ ...command, expiresAt: new Date(Date.now() - 1).toISOString() }, fixture.entry))
      .toEqual({ ok: false, code: 'workspace_request_expired' })
    expect(await readWorkspace({ ...command, root: '/etc' } as WorkspaceReadCommand, fixture.entry))
      .toEqual({ ok: false, code: 'workspace_invalid_request' })
  })

  it('uses content hash and HEAD to reject stale mentions, including deletion and growth beyond the limit', async () => {
    fixture.write('version.txt', 'original')
    const first = success(await fixture.read({ kind: 'file', path: 'version.txt' }), 'file')
    const expected = { headSha: first.revision.headSha, contentSha256: first.contentSha256! }
    expect(success(await fixture.read({ kind: 'file', path: 'version.txt', expected }), 'file').content).toBe('original')
    expect(await fixture.read({ kind: 'file', path: 'version.txt', expected: { ...expected, headSha: '0'.repeat(40) } }))
      .toEqual({ ok: false, code: 'workspace_version_conflict' })
    fixture.write('version.txt', 'modified')
    expect(await fixture.read({ kind: 'file', path: 'version.txt', expected })).toEqual({ ok: false, code: 'workspace_version_conflict' })
    fixture.write('version.txt', Buffer.alloc(WORKSPACE_MAX_FILE_BYTES + 1, 0x61))
    expect(await fixture.read({ kind: 'file', path: 'version.txt', expected })).toEqual({ ok: false, code: 'workspace_version_conflict' })
    rmSync(join(fixture.root, 'version.txt'))
    expect(await fixture.read({ kind: 'file', path: 'version.txt', expected })).toEqual({ ok: false, code: 'workspace_version_conflict' })
    expect(await fixture.read({ kind: 'file', path: 'version.txt' })).toEqual({ ok: false, code: 'workspace_path_unavailable' })
  })

  it('resolves folder context with bounded text and omits binary and oversized files', async () => {
    fixture.write('context/one.ts', 'one\n')
    fixture.write('context/nested/two.md', 'two\n')
    fixture.write('context/binary.txt', Buffer.from([0xff]))
    fixture.write('context/large.txt', Buffer.alloc(WORKSPACE_MAX_FILE_BYTES + 1, 0x61))
    fixture.write('context/.env', 'fixture-secret')
    const result = success(await fixture.read({ kind: 'context', selection: { kind: 'folder', path: 'context' } }), 'context')
    expect(result.omitted).toBe(2)
    expect(result.files.map(file => file.path)).toEqual(['context/nested/two.md', 'context/one.ts'])
    expect(JSON.stringify(result)).not.toContain('fixture-secret')
    expect(await fixture.read({ kind: 'context', selection: { kind: 'file', path: 'context/binary.txt' } }))
      .toEqual({ ok: false, code: 'workspace_unsupported' })
  })

  it('rechecks every resolved folder member and does not silently retarget a stale member', async () => {
    fixture.write('context/a.ts', 'a')
    fixture.write('context/b.ts', 'b')
    const first = success(await fixture.read({ kind: 'context', selection: { kind: 'folder', path: 'context' } }), 'context')
    const files = first.files.map(file => ({ path: file.path, expected: { headSha: file.revision.headSha, contentSha256: file.contentSha256! } }))
    const request = { kind: 'context', selection: { kind: 'resolved', files } }
    expect(success(await fixture.read(request), 'context').files).toHaveLength(2)
    fixture.write('context/b.ts', 'changed')
    expect(await fixture.read(request)).toEqual({ ok: false, code: 'workspace_version_conflict' })
    rmSync(join(fixture.root, 'context/b.ts'))
    expect(await fixture.read(request)).toEqual({ ok: false, code: 'workspace_version_conflict' })
  })

  it('enforces the aggregate 64 KiB context budget and 20-file folder bound', async () => {
    fixture.write('bytes/a.txt', 'a'.repeat(40 * 1024))
    fixture.write('bytes/b.txt', 'b'.repeat(40 * 1024))
    expect(await fixture.read({ kind: 'context', selection: { kind: 'folder', path: 'bytes' } }))
      .toEqual({ ok: false, code: 'workspace_limit_exceeded' })
    for (let index = 0; index < 21; index++) fixture.write(`many/${index}.ts`, 'file')
    expect(await fixture.read({ kind: 'context', selection: { kind: 'folder', path: 'many' } }))
      .toEqual({ ok: false, code: 'workspace_limit_exceeded' })
  })

  it('rejects a changed HEAD even when the file contents remain identical during the read', async () => {
    const original = success(await fixture.read({ kind: 'file', path: 'README.md' }), 'file')
    const probe = await open(join(fixture.root, 'README.md'), 'r')
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read }
    await probe.close()
    const originalRead = prototype.read
    let committed = false
    vi.spyOn(prototype, 'read').mockImplementation(async function (this: typeof probe, ...args: Parameters<typeof probe.read>) {
      const result = await originalRead.apply(this, args)
      if (!committed) {
        committed = true
        git(fixture.root, '-c', 'user.name=Workspace Fixture', '-c', 'user.email=fixture@mikka.invalid',
          'commit', '--allow-empty', '-qm', 'concurrent agent commit')
      }
      return result
    })
    expect(await fixture.read({ kind: 'file', path: 'README.md', expected: {
      headSha: original.revision.headSha, contentSha256: original.contentSha256!,
    } })).toEqual({ ok: false, code: 'workspace_version_conflict' })
    expect(committed).toBe(true)
    expect(git(fixture.root, 'rev-parse', 'HEAD')).not.toBe(fixture.headSha)
  })

  it('rejects schema-valid forged receipts for another binding, path, source, hash, or line selection', async () => {
    const original = success(await fixture.read({ kind: 'file', path: 'README.md' }), 'file')
    const command = fixture.command({ kind: 'file', path: 'README.md', expected: {
      headSha: original.revision.headSha, contentSha256: original.contentSha256!,
    } })
    const forgeries = [
      { ...original, identity: { ...original.identity, workspaceId: randomUUID() } },
      { ...original, identity: { ...original.identity, bindingId: digest('different binding') } },
      { ...original, path: 'other.md' },
      { ...original, revision: { ...original.revision, source: 'checkpoint' } },
      { ...original, revision: { ...original.revision, headSha: '0'.repeat(40) } },
      { ...original, contentSha256: digest('different contents') },
      { ...original, startLine: 2 },
      { ...original, endLine: original.endLine + 1 },
      { ...original, format: 'binary' },
    ]
    for (const forgery of forgeries) {
      const parsed = workspaceReadResult.parse(forgery)
      expect(matchesWorkspaceResponse(command.request, fixture.identity, parsed), JSON.stringify(forgery)).toBe(false)
    }
    const treeCommand = fixture.command({ kind: 'tree', path: '' })
    const tree = success(await fixture.read(treeCommand.request), 'tree')
    const escaped = workspaceReadResult.parse({ ...tree, entries: [{ path: 'nested/file.txt', name: 'file.txt', kind: 'file', size: 1 }] })
    expect(matchesWorkspaceResponse(treeCommand.request, fixture.identity, escaped)).toBe(false)
  })

  it('rejects a context receipt that swaps a nested file to another run or omits a selected member', async () => {
    fixture.write('context/a.ts', 'a')
    fixture.write('context/b.ts', 'b')
    const command = fixture.command({ kind: 'context', selection: { kind: 'resolved', files: [{ path: 'context/a.ts' }, { path: 'context/b.ts' }] } })
    const context = success(await fixture.read(command.request), 'context')
    const foreignFile = { ...context.files[1]!, identity: { ...fixture.identity, runId: randomUUID() } }
    for (const forgery of [
      { ...context, files: [context.files[0]!, foreignFile] },
      { ...context, files: [context.files[0]!] },
      { ...context, files: [context.files[1]!, context.files[0]!] },
    ]) {
      const parsed = workspaceReadResult.parse(forgery)
      expect(matchesWorkspaceResponse(command.request, fixture.identity, parsed)).toBe(false)
    }
  })

  it.each(['parent', 'root', 'content'] as const)('fails closed when a real %s changes during an open file read', async mutation => {
    fixture.write('race/file.txt', 'original-file-contents')
    const original = success(await fixture.read({ kind: 'file', path: 'race/file.txt' }), 'file')
    const probe = await open(join(fixture.root, 'race/file.txt'), 'r')
    const prototype = Object.getPrototypeOf(probe) as { read: typeof probe.read }
    await probe.close()
    const originalRead = prototype.read
    let changed = false
    vi.spyOn(prototype, 'read').mockImplementation(async function (this: typeof probe, ...args: Parameters<typeof probe.read>) {
      const result = await originalRead.apply(this, args)
      if (!changed) {
        changed = true
        if (mutation === 'content') fixture.write('race/file.txt', 'changed-file-contents')
        else if (mutation === 'parent') {
          const outside = join(fixture.directory, 'outside-race')
          mkdirSync(outside)
          writeFileSync(join(outside, 'file.txt'), 'outside-fixture-secret')
          renameSync(join(fixture.root, 'race'), join(fixture.root, 'moved-race'))
          symlinkSync(outside, join(fixture.root, 'race'), 'dir')
        } else {
          renameSync(fixture.root, join(fixture.directory, 'moved-checkout'))
          mkdirSync(join(fixture.root, 'race'), { recursive: true })
          writeFileSync(join(fixture.root, 'race/file.txt'), 'replacement-checkout-secret')
        }
      }
      return result
    })
    const result = await fixture.read({ kind: 'file', path: 'race/file.txt', expected: {
      headSha: original.revision.headSha, contentSha256: original.contentSha256!,
    } })
    expect(changed).toBe(true)
    expect(result).toEqual({ ok: false, code: 'workspace_version_conflict' })
    expect(JSON.stringify(result)).not.toContain('secret')
  })
})
