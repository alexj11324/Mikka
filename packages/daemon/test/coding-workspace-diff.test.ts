import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { matchesWorkspaceResponse, workspaceReadReceipt, workspaceReadRequest,
  type RunWorktreeIdentity, type WorkspaceReadCommand, type WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_MAX_BLOB_BYTES, type DiffFileMetadata, type WorkspaceDiffReadResult } from '@mikka/protocol/coding-workspace-review'
import { remoteKey } from '@mikka/protocol/repository'
import { readWorkspaceDiffReceipt } from '../src/coding-workspace/diff'
import { RunJournal } from '../src/runs/journal'
import { cleanupTempDirs, makeRepo, tempDir } from './helpers'

const remote = 'https://github.com/mikka-fixtures/coding-workspace-diff.git'
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const blobId = (value: string | Buffer) => {
  const bytes = Buffer.from(value)
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Workspace Diff Fixture',
  '-c', 'user.email=workspace-diff@mikka.invalid', ...args], { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim()

function success<K extends 'diff_snapshot' | 'diff_file'>(receipt: WorkspaceReadReceipt, kind: K) {
  expect(receipt.result).toMatchObject({ ok: true, kind })
  if (!receipt.result.ok || receipt.result.kind !== kind) throw new Error(`Expected successful ${kind}`)
  return receipt.result as Extract<WorkspaceDiffReadResult, { kind: K }>
}

function proofs(receipt: WorkspaceReadReceipt) {
  const rows = receipt.blobs ?? []
  expect(new Set(rows.map(row => row.sha)).size).toBe(rows.length)
  const verified = new Map<string, Buffer>()
  for (const proof of rows) {
    const raw = Buffer.from(proof.base64, 'base64')
    expect(raw.toString('base64')).toBe(proof.base64)
    const bytes = proof.clean === 'crlf_to_lf'
      ? Buffer.from(raw.toString('latin1').replaceAll('\r\n', '\n'), 'latin1') : raw
    if (proof.clean) expect(proof.rawSha).toBe(blobId(raw))
    expect(blobId(bytes)).toBe(proof.sha)
    verified.set(proof.sha, bytes)
  }
  return verified
}

/** Built-in Git conversion is the oracle; no -w, index update or external filter. */
const cleanBlobId = (cwd: string, path: string, bytes: Buffer) => execFileSync('git',
  ['-c', 'core.safecrlf=false', 'hash-object', `--path=${path}`, '--stdin'], { cwd, input: bytes, stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim()

async function makeFixture() {
  const repository = await makeRepo()
  git(repository, 'remote', 'add', 'origin', remote)
  for (const [path, value] of [['tracked.txt', 'frozen base\n'], ['rename.txt', 'unique rename contents\n'], ['deleted.txt', 'delete these bytes\n']]) {
    writeFileSync(join(repository, path!), value!)
  }
  git(repository, 'add', '--', 'tracked.txt', 'rename.txt', 'deleted.txt')
  git(repository, 'commit', '-qm', 'seed frozen base')
  const directory = tempDir('mikka-workspace-diff-'), root = join(directory, 'checkout')
  git(repository, 'worktree', 'add', '-q', '--detach', root, 'HEAD')
  const baseSha = git(root, 'rev-parse', 'HEAD')
  const identity: RunWorktreeIdentity = { version: 1, runId: randomUUID(), repoId: randomUUID(), deviceId: randomUUID(),
    workspaceId: randomUUID(), ownerId: 'workspace-diff-test-owner', repositoryKey: remoteKey(remote), bindingId: digest('diff-fixture-binding') }
  const journalFile = join(directory, 'journal.json')
  new RunJournal(journalFile).put({ assignment: { runId: identity.runId, issueId: randomUUID(), repoId: identity.repoId,
    deviceId: identity.deviceId, remoteUrl: remote, baseBranch: 'main', harness: 'mock', prompt: 'Read workspace diff' },
  state: 'running', sessionId: null, worktree: root, baseCommit: baseSha, lastSeq: 0, error: null, updatedAt: new Date().toISOString() })
  const entry = () => new RunJournal(journalFile).get(identity.runId)!
  const command = (request: unknown): WorkspaceReadCommand => ({ id: randomUUID(), identity,
    request: workspaceReadRequest.parse(request), expiresAt: new Date(Date.now() + 15_000).toISOString() })
  const read = async (request: unknown) => {
    const input = command(request)
    const receipt = workspaceReadReceipt.parse(await readWorkspaceDiffReceipt(input, entry(), repository))
    expect(matchesWorkspaceResponse(input.request, identity, receipt.result)).toBe(true)
    return receipt
  }
  const write = (path: string, value: string | Buffer) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), value)
  }
  const commit = (message: string) => { git(root, 'add', '--all'); git(root, 'commit', '-qm', message); return git(root, 'rev-parse', 'HEAD') }
  const freezeBase = () => {
    const sha = git(root, 'rev-parse', 'HEAD')
    new RunJournal(journalFile).put({ ...entry(), baseCommit: sha })
    return sha
  }
  return { repository, directory, root, baseSha, identity, entry, command, read, write, commit, freezeBase }
}

const fileRequest = (snapshot: Extract<WorkspaceDiffReadResult, { kind: 'diff_snapshot' }>, file: DiffFileMetadata) => ({
  kind: 'diff_file' as const, snapshotId: randomUUID(), revision: snapshot.revision, file,
})
const byPath = (snapshot: Extract<WorkspaceDiffReadResult, { kind: 'diff_snapshot' }>, path: string) => {
  const file = snapshot.files.find(file => file.path === path)
  expect(file, path).toBeDefined()
  return file!
}

/** Byte/content metadata only, without following links or comparing access time. */
function directoryState(directory: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {}
  const visit = (parent: string, prefix: string) => {
    for (const name of readdirSync(parent).sort()) {
      const file = join(parent, name), path = prefix ? `${prefix}/${name}` : name
      const stat = lstatSync(file, { bigint: true })
      if (stat.isDirectory()) { entries[path] = { kind: 'directory', mode: Number(stat.mode) }; visit(file, path) }
      else entries[path] = { kind: stat.isSymbolicLink() ? 'link' : 'file', mode: Number(stat.mode),
        size: String(stat.size), inode: String(stat.ino), modified: String(stat.mtimeNs), changed: String(stat.ctimeNs),
        value: stat.isSymbolicLink() ? readlinkSync(file) : digest(readFileSync(file)) }
    }
  }
  visit(directory, '')
  return entries
}

async function afterFileRead(callback: (path: string) => void) {
  const handle = await open('/dev/null', 'r')
  const prototype = Object.getPrototypeOf(handle) as { read: typeof handle.read }
  const original = prototype.read
  await handle.close()
  vi.spyOn(prototype, 'read').mockImplementation(async function (this: typeof handle, ...args: Parameters<typeof handle.read>) {
    const result = await original.apply(this, args)
    callback(await realpath(`/proc/self/fd/${this.fd}`))
    return result
  })
}

afterEach(() => { vi.restoreAllMocks(); cleanupTempDirs() })

describe.skipIf(process.platform !== 'linux')('coding workspace Diff on a real Git worktree and journal', () => {
  let fixture: Awaited<ReturnType<typeof makeFixture>>
  beforeEach(async () => { fixture = await makeFixture() })

  it('combines committed, staged, unstaged and untracked contents against the frozen base', async () => {
    fixture.write('committed.txt', 'new committed bytes\n')
    const head = fixture.commit('a task commit after the frozen base')
    fixture.write('tracked.txt', 'staged intermediate bytes\n')
    git(fixture.root, 'add', '--', 'tracked.txt')
    fixture.write('tracked.txt', 'actual unstaged bytes\n')
    fixture.write('staged.txt', 'staged new file\n'); git(fixture.root, 'add', '--', 'staged.txt')
    fixture.write('untracked.txt', 'untracked new file\n')
    fixture.write('.gitignore', readFileSync(join(fixture.root, '.gitignore'), 'utf8') + 'ignored-diff.txt\n')
    fixture.write('ignored-diff.txt', 'must stay out of the manifest')
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    expect(snapshot.revision).toMatchObject({ source: 'working', baseSha: fixture.baseSha, headSha: head, treeSha: null })
    expect(snapshot.files.map(file => file.path)).toEqual(['.gitignore', 'committed.txt', 'staged.txt', 'tracked.txt', 'untracked.txt'])
    expect(byPath(snapshot, 'tracked.txt')).toMatchObject({ status: 'modified', oldBlob: blobId('frozen base\n'), newBlob: blobId('actual unstaged bytes\n') })
    for (const path of ['committed.txt', 'staged.txt', 'untracked.txt']) expect(byPath(snapshot, path).status).toBe('added')
    const receipt = await fixture.read(fileRequest(snapshot, byPath(snapshot, 'tracked.txt')))
    expect([...proofs(receipt).values()].map(bytes => bytes.toString())).toEqual(['frozen base\n', 'actual unstaged bytes\n'])
    expect(JSON.stringify(receipt)).not.toContain('staged intermediate bytes')
    expect(snapshot.identity).toEqual(fixture.identity)
    expect(Number.isFinite(Date.parse(snapshot.observedAt))).toBe(true)
  })

  it('reads explicit ancestor commits from their objects even when HEAD and the worktree have moved on', async () => {
    fixture.write('tracked.txt', 'chosen historical contents\n')
    const chosenHead = fixture.commit('selected historical commit')
    fixture.write('tracked.txt', 'later committed contents\n'); fixture.commit('later descendant')
    fixture.write('tracked.txt', 'current worktree must not supply commit proof\n')
    fixture.write('untracked.txt', 'must not enter an explicit commit diff')
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'commit', baseSha: fixture.baseSha, headSha: chosenHead }), 'diff_snapshot')
    expect(snapshot.revision).toMatchObject({ source: 'commit', baseSha: fixture.baseSha, headSha: chosenHead, treeSha: git(fixture.root, 'rev-parse', `${chosenHead}^{tree}`) })
    expect(snapshot.files.map(file => file.path)).toEqual(['tracked.txt'])
    const receipt = await fixture.read(fileRequest(snapshot, snapshot.files[0]!))
    expect([...proofs(receipt).values()].map(bytes => bytes.toString())).toEqual(['frozen base\n', 'chosen historical contents\n'])
  })

  it('refuses unrelated or reversed explicit commits without accepting arbitrary reachable object IDs', async () => {
    fixture.write('tracked.txt', 'descendant\n')
    const head = fixture.commit('descendant')
    const tree = git(fixture.root, 'rev-parse', `${head}^{tree}`)
    const orphan = git(fixture.root, 'commit-tree', tree, '-m', 'unrelated history, no parent')
    for (const [baseSha, headSha] of [[fixture.baseSha, orphan], [orphan, head], [head, fixture.baseSha], [fixture.baseSha, '0'.repeat(40)]]) {
      const receipt = await fixture.read({ kind: 'diff_snapshot', source: 'commit', baseSha, headSha })
      expect(receipt).toEqual({ result: { ok: false, code: 'workspace_checkout_unavailable' }, files: [] })
    }
  })

  it('returns byte-exact old/new Git blob proofs for UTF-8 BOM and CRLF, separate from the public patch', async () => {
    const before = Buffer.from('\uFEFFold line\r\n尾行\r\n'), after = Buffer.from('\uFEFFnew line\r\n尾行\r\n')
    fixture.write('unicode.txt', before); fixture.commit('seed Unicode'); fixture.freezeBase()
    fixture.write('unicode.txt', after)
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const receipt = await fixture.read(fileRequest(snapshot, byPath(snapshot, 'unicode.txt')))
    const result = success(receipt, 'diff_file'), verified = proofs(receipt)
    expect(result).toMatchObject({ format: 'text', patch: null, hunks: [], file: { oldSize: before.length, newSize: after.length } })
    expect(verified.get(blobId(before))).toEqual(before)
    expect(verified.get(blobId(after))).toEqual(after)
    expect(receipt.files).toEqual([])
    expect(result).not.toHaveProperty('blobs')
    expect(JSON.stringify(result)).not.toContain(after.toString('base64'))
  })

  it('honors legacy crlf=auto without depending on core.autocrlf', async () => {
    git(fixture.root, 'config', 'core.autocrlf', 'false')
    fixture.write('.gitattributes', 'tracked.txt crlf=auto\n')
    fixture.commit('enable legacy automatic CRLF conversion'); fixture.freezeBase()
    fixture.write('tracked.txt', 'frozen base\r\n')
    expect(git(fixture.root, 'diff', '--name-only', 'HEAD', '--', 'tracked.txt')).toBe('')
    expect(success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot').files).toEqual([])

    const raw = Buffer.from('changed legacy contents\r\n'), normalized = Buffer.from('changed legacy contents\n')
    fixture.write('tracked.txt', raw)
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const file = byPath(snapshot, 'tracked.txt')
    expect(file).toMatchObject({ newBlob: blobId(normalized), newSize: normalized.length, rawBlob: blobId(raw), rawSize: raw.length })
    const receipt = await fixture.read(fileRequest(snapshot, file))
    expect(proofs(receipt).get(blobId(normalized))).toEqual(normalized)
    expect(receipt.blobs?.find(proof => proof.sha === blobId(normalized)))
      .toEqual({ sha: blobId(normalized), base64: raw.toString('base64'), clean: 'crlf_to_lf', rawSha: blobId(raw) })
    // Only the fixture writes its index: the actual Git clean result confirms
    // the canonical object chosen by the preceding read-only operation.
    git(fixture.root, 'add', '--', 'tracked.txt')
    expect(git(fixture.root, 'rev-parse', ':tracked.txt')).toBe(blobId(normalized))
  })

  it('refuses NUL-truncated attribute values rather than hiding a real working change', async () => {
    git(fixture.root, 'config', 'core.autocrlf', 'false')
    fixture.write('.gitattributes', 'tracked.txt text=set\0ignored\n')
    fixture.write('tracked.txt', 'frozen base\r\n')
    expect(git(fixture.root, 'check-attr', 'text', '--', 'tracked.txt')).toBe('tracked.txt: text: set')
    expect(git(fixture.root, 'diff', '--name-only', 'HEAD', '--', 'tracked.txt')).toBe('tracked.txt')
    expect(await fixture.read({ kind: 'diff_snapshot', source: 'working' }))
      .toEqual({ result: { ok: false, code: 'workspace_unsupported' }, files: [] })
  })

  it('keeps a clean text eol=crlf checkout empty and binds edits to LF blobs while retaining complete raw proof', async () => {
    git(fixture.root, 'config', 'core.autocrlf', 'false')
    fixture.write('.gitattributes', 'eol.txt text eol=crlf\n')
    fixture.write('eol.txt', 'before\nlast\n')
    fixture.commit('seed LF blob with CRLF checkout policy'); fixture.freezeBase()
    rmSync(join(fixture.root, 'eol.txt')); git(fixture.root, 'checkout', '--', 'eol.txt')
    expect(readFileSync(join(fixture.root, 'eol.txt'))).toEqual(Buffer.from('before\r\nlast\r\n'))
    expect(git(fixture.root, 'diff', '--name-only', 'HEAD')).toBe('')
    expect(success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot').files).toEqual([])

    const raw = Buffer.from('after\r\nlast\r\n'), normalized = Buffer.from('after\nlast\n')
    fixture.write('eol.txt', raw)
    expect(cleanBlobId(fixture.root, 'eol.txt', raw)).toBe(blobId(normalized))
    const before = { clone: directoryState(fixture.repository), worktree: directoryState(fixture.root) }
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const file = byPath(snapshot, 'eol.txt')
    expect(file).toMatchObject({ status: 'modified', oldBlob: blobId('before\nlast\n'), newBlob: blobId(normalized),
      oldSize: Buffer.byteLength('before\nlast\n'), newSize: normalized.length, rawBlob: blobId(raw), rawSize: raw.length })
    const receipt = await fixture.read(fileRequest(snapshot, file))
    expect(proofs(receipt).get(blobId(normalized))).toEqual(normalized)
    expect(receipt.blobs?.find(proof => proof.sha === blobId(normalized))).toEqual({
      sha: blobId(normalized), base64: raw.toString('base64'), clean: 'crlf_to_lf', rawSha: blobId(raw),
    })
    expect(JSON.stringify(receipt.result)).not.toContain(raw.toString('base64'))
    expect(receipt.files).toEqual([])
    expect({ clone: directoryState(fixture.repository), worktree: directoryState(fixture.root) }).toEqual(before)
  })

  it('preserves CRLF for -text even with eol=crlf and core.autocrlf=true', async () => {
    git(fixture.root, 'config', 'core.autocrlf', 'true')
    fixture.write('.gitattributes', 'eol.txt -text eol=crlf\n')
    const before = Buffer.from('before\r\nlast\r\n'), after = Buffer.from('after\r\nlast\r\n')
    fixture.write('eol.txt', before); fixture.commit('seed explicit raw CRLF'); fixture.freezeBase()
    expect(git(fixture.root, 'rev-parse', 'HEAD:eol.txt')).toBe(blobId(before))
    fixture.write('eol.txt', after)
    expect(cleanBlobId(fixture.root, 'eol.txt', after)).toBe(blobId(after))
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const file = byPath(snapshot, 'eol.txt')
    expect(file).toMatchObject({ oldBlob: blobId(before), newBlob: blobId(after), newSize: after.length })
    const receipt = await fixture.read(fileRequest(snapshot, file))
    expect(proofs(receipt).get(blobId(after))).toEqual(after)
    expect(receipt.blobs?.find(proof => proof.sha === blobId(after))).not.toHaveProperty('clean')
  })

  it.each(['text=auto', 'core.autocrlf=input', 'core.autocrlf=true'] as const)(
    'matches Git %s for text while preserving NUL and lone-CR bytes', async policy => {
      git(fixture.root, 'config', 'core.autocrlf', policy.startsWith('core.') ? policy.split('=')[1]! : 'false')
      if (policy === 'text=auto') fixture.write('.gitattributes', 'auto-* text=auto\n')
      const rows = [
        { path: 'auto-text.txt', before: 'before\nlast\n', raw: 'after\r\nlast\r\n', normalized: 'after\nlast\n' },
        { path: 'auto-nul.bin', before: 'before\0last\r\n', raw: 'after\0last\r\n', normalized: 'after\0last\r\n' },
        { path: 'auto-cr.txt', before: 'before\rlast\r\n', raw: 'after\rlast\r\n', normalized: 'after\rlast\r\n' },
      ]
      for (const row of rows) fixture.write(row.path, row.before)
      fixture.commit(`seed ${policy} text and binary files`); fixture.freezeBase()
      for (const row of rows) fixture.write(row.path, row.raw)
      const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
      expect(snapshot.files.map(file => file.path)).toEqual(rows.map(row => row.path).sort())
      for (const row of rows) {
        const raw = Buffer.from(row.raw), normalized = Buffer.from(row.normalized)
        expect(cleanBlobId(fixture.root, row.path, raw)).toBe(blobId(normalized))
        const file = byPath(snapshot, row.path)
        expect(file).toMatchObject({ newBlob: blobId(normalized), newSize: normalized.length })
        const receipt = await fixture.read(fileRequest(snapshot, file))
        expect(proofs(receipt).get(blobId(normalized))).toEqual(normalized)
        const proof = receipt.blobs?.find(proof => proof.sha === blobId(normalized))
        expect(proof?.base64).toBe(raw.toString('base64'))
        if (raw.equals(normalized)) expect(proof).not.toHaveProperty('clean')
        else expect(proof).toMatchObject({ clean: 'crlf_to_lf', rawSha: blobId(raw) })
      }
    })

  it.each(['text=auto', 'core.autocrlf=input', 'core.autocrlf=true'] as const)(
    'preserves an existing nonbinary CRLF index blob under %s without renormalizing it', async policy => {
      git(fixture.root, 'config', 'core.autocrlf', 'false')
      const before = Buffer.from('already indexed\r\nlast\r\n'), after = Buffer.from('edited indexed\r\nlast\r\n')
      fixture.write('indexed-crlf.txt', before); fixture.commit('seed existing CRLF index blob'); fixture.freezeBase()
      expect(git(fixture.root, 'rev-parse', ':indexed-crlf.txt')).toBe(blobId(before))
      if (policy === 'text=auto') fixture.write('.gitattributes', 'indexed-crlf.txt text=auto\n')
      else git(fixture.root, 'config', 'core.autocrlf', policy.split('=')[1]!)
      expect(git(fixture.root, 'diff', '--name-only', 'HEAD', '--', 'indexed-crlf.txt')).toBe('')
      const clean = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
      expect(clean.files.some(file => file.path === 'indexed-crlf.txt')).toBe(false)
      fixture.write('indexed-crlf.txt', after)
      const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
      const file = byPath(snapshot, 'indexed-crlf.txt')
      expect(file).toMatchObject({ oldBlob: blobId(before), newBlob: blobId(after), newSize: after.length })
      const receipt = await fixture.read(fileRequest(snapshot, file))
      expect(proofs(receipt).get(blobId(after))).toEqual(after)
      expect(receipt.blobs?.find(proof => proof.sha === blobId(after))).not.toHaveProperty('clean')
      // hash-object does not load the index, so it is not an oracle for Git's
      // existing-CRLF protection. After the read, verify ordinary git add keeps
      // the raw bytes in the index instead of renormalizing them.
      git(fixture.root, 'add', '--', 'indexed-crlf.txt')
      expect(git(fixture.root, 'rev-parse', ':indexed-crlf.txt')).toBe(blobId(after))
    })

  it('evaluates unstaged worktree attributes and fences old snapshots when their conversion changes', async () => {
    git(fixture.root, 'config', 'core.autocrlf', 'false')
    fixture.write('.gitattributes', 'nested/eol.txt -text\n')
    fixture.write('nested/eol.txt', 'before\n'); fixture.commit('seed raw attributes'); fixture.freezeBase()
    const raw = Buffer.from('after\r\nlast\r\n'), normalized = Buffer.from('after\nlast\n')
    fixture.write('nested/eol.txt', raw)
    const first = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    expect(byPath(first, 'nested/eol.txt').newBlob).toBe(blobId(raw))
    fixture.write('nested/.gitattributes', 'eol.txt text eol=crlf\n')
    expect(git(fixture.root, 'diff', '--cached', '--name-only')).toBe('')
    expect(git(fixture.root, 'check-attr', 'text', '--', 'nested/eol.txt')).toBe('nested/eol.txt: text: set')
    expect(git(fixture.root, 'check-attr', '--cached', 'text', '--', 'nested/eol.txt')).toBe('nested/eol.txt: text: unset')
    expect(cleanBlobId(fixture.root, 'nested/eol.txt', raw)).toBe(blobId(normalized))
    expect(await fixture.read(fileRequest(first, byPath(first, 'nested/eol.txt'))))
      .toEqual({ result: { ok: false, code: 'workspace_version_conflict' }, files: [] })
    const before = { clone: directoryState(fixture.repository), worktree: directoryState(fixture.root) }
    const second = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    expect(byPath(second, 'nested/eol.txt').newBlob).toBe(blobId(normalized))
    expect(second.revision.version).not.toBe(first.revision.version)
    expect(proofs(await fixture.read(fileRequest(second, byPath(second, 'nested/eol.txt')))).get(blobId(normalized))).toEqual(normalized)
    expect({ clone: directoryState(fixture.repository), worktree: directoryState(fixture.root) }).toEqual(before)
  })

  it('uses the index mode when core.filemode=false even when both filesystem executable bits disagree', async () => {
    git(fixture.root, 'config', 'core.filemode', 'true')
    fixture.write('normal.txt', 'normal\n'); fixture.write('executable.sh', 'executable\n')
    chmodSync(join(fixture.root, 'normal.txt'), 0o644); chmodSync(join(fixture.root, 'executable.sh'), 0o755)
    fixture.commit('seed normal and executable modes'); fixture.freezeBase()
    git(fixture.root, 'config', 'core.filemode', 'false')
    chmodSync(join(fixture.root, 'normal.txt'), 0o755); chmodSync(join(fixture.root, 'executable.sh'), 0o644)
    expect(git(fixture.root, 'diff', '--name-only', 'HEAD')).toBe('')
    expect(success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot').files).toEqual([])
    fixture.write('normal.txt', 'changed normal\n'); fixture.write('executable.sh', 'changed executable\n')
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    expect(byPath(snapshot, 'normal.txt')).toMatchObject({ oldMode: '100644', newMode: '100644' })
    expect(byPath(snapshot, 'executable.sh')).toMatchObject({ oldMode: '100755', newMode: '100755' })
  })

  it('normalizes CRLF split across streaming read boundaries without dropping lone CR bytes in forced text', async () => {
    fixture.write('.gitattributes', 'boundary.txt text\n')
    fixture.write('boundary.txt', 'before\n'); fixture.commit('seed explicit text'); fixture.freezeBase()
    const raw = Buffer.from(`${'x'.repeat(65_535)}\r\nlast\r\ntrailing\r`)
    const normalized = Buffer.from(`${'x'.repeat(65_535)}\nlast\ntrailing\r`)
    fixture.write('boundary.txt', raw)
    expect(cleanBlobId(fixture.root, 'boundary.txt', raw)).toBe(blobId(normalized))
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const receipt = await fixture.read(fileRequest(snapshot, byPath(snapshot, 'boundary.txt')))
    expect(proofs(receipt).get(blobId(normalized))?.equals(normalized)).toBe(true)
    const proof = receipt.blobs?.find(proof => proof.sha === blobId(normalized))
    expect(proof).toBeDefined()
    expect(proof).toMatchObject({ clean: 'crlf_to_lf', rawSha: blobId(raw) })
    expect(Buffer.from(proof!.base64, 'base64').equals(raw)).toBe(true)
  })

  it('represents an exact rename and deletion without guessing edited-move anchors', async () => {
    renameSync(join(fixture.root, 'rename.txt'), join(fixture.root, 'renamed.txt'))
    rmSync(join(fixture.root, 'deleted.txt'))
    fixture.write('moved-and-edited.txt', 'frozen base changed during its move\n')
    rmSync(join(fixture.root, 'tracked.txt'))
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const renamed = byPath(snapshot, 'renamed.txt'), deleted = byPath(snapshot, 'deleted.txt')
    expect(renamed).toMatchObject({ status: 'renamed', previousPath: 'rename.txt', oldBlob: blobId('unique rename contents\n'), newBlob: blobId('unique rename contents\n') })
    expect(deleted).toMatchObject({ status: 'deleted', previousPath: null, oldBlob: blobId('delete these bytes\n'), newBlob: null })
    expect(byPath(snapshot, 'moved-and-edited.txt')).toMatchObject({ status: 'added', previousPath: null })
    expect(byPath(snapshot, 'tracked.txt').status).toBe('deleted')
    expect(snapshot.files.some(file => file.path === 'rename.txt')).toBe(false)
    expect(proofs(await fixture.read(fileRequest(snapshot, renamed))).size).toBe(1)
    expect([...proofs(await fixture.read(fileRequest(snapshot, deleted))).values()]).toEqual([Buffer.from('delete these bytes\n')])
  })

  it('marks binary bytes and keeps them in private blob proof with no manufactured text patch', async () => {
    for (const [path, bytes] of [['nul.bin', Buffer.from('a\0b')], ['invalid.txt', Buffer.from([0xff, 0xfe, 0x61])]] as const) fixture.write(path, bytes)
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    for (const [path, bytes] of [['nul.bin', Buffer.from('a\0b')], ['invalid.txt', Buffer.from([0xff, 0xfe, 0x61])]] as const) {
      const file = byPath(snapshot, path)
      expect(file).toMatchObject({ binary: true, newBlob: blobId(bytes), newSize: bytes.length })
      const receipt = await fixture.read(fileRequest(snapshot, file))
      expect(success(receipt, 'diff_file')).toMatchObject({ patch: null, hunks: [] })
      expect(proofs(receipt).get(blobId(bytes))).toEqual(bytes)
    }
  })

  it('recognizes unchanged large files and withholds oversized changed file bytes', async () => {
    const bytes = Buffer.alloc(WORKSPACE_DIFF_MAX_BLOB_BYTES + 1, 0x61)
    fixture.write('large.txt', bytes); fixture.commit('seed large text'); fixture.freezeBase()
    expect(success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot').files).toEqual([])
    bytes[bytes.length - 1] = 0x62; fixture.write('large.txt', bytes)
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const file = byPath(snapshot, 'large.txt')
    expect(file).toMatchObject({ status: 'modified', newSize: bytes.length, newBlob: blobId(bytes) })
    const receipt = await fixture.read(fileRequest(snapshot, file))
    expect(success(receipt, 'diff_file')).toMatchObject({ format: 'too_large', patch: null, hunks: [] })
    expect(receipt.files).toEqual([]); expect(receipt.blobs ?? []).toEqual([])
  })

  it('keeps replaced symlinks and hardlinks unavailable without copying their target or old bytes', async () => {
    const outside = join(fixture.directory, 'outside.txt')
    writeFileSync(outside, 'outside-private-test-fixture')
    rmSync(join(fixture.root, 'tracked.txt')); symlinkSync(outside, join(fixture.root, 'tracked.txt'))
    linkSync(outside, join(fixture.root, 'hardlink.txt'))
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    for (const path of ['tracked.txt', 'hardlink.txt']) {
      const file = byPath(snapshot, path)
      expect(file).toMatchObject({ status: 'unavailable', newMode: '000000', newBlob: null })
      const receipt = await fixture.read(fileRequest(snapshot, file))
      expect(success(receipt, 'diff_file')).toMatchObject({ format: 'unavailable', patch: null, hunks: [] })
      expect(receipt.files).toEqual([]); expect(receipt.blobs ?? []).toEqual([])
      expect(JSON.stringify(receipt)).not.toContain('outside-private-test-fixture')
    }
  })

  it('applies the protected-path policy to both working and historical manifests, including tracked files', async () => {
    fixture.write('.env', 'PROTECTED_TRACKED_FIXTURE=1\n')
    fixture.write('keys/private.pem', 'PROTECTED_TRACKED_CERTIFICATE')
    fixture.write('.github/workflows/check.yml', 'name: safe workflow\n')
    const head = fixture.commit('track safe and protected fixture files')
    for (const request of [{ kind: 'diff_snapshot', source: 'working' },
      { kind: 'diff_snapshot', source: 'commit', baseSha: fixture.baseSha, headSha: head }]) {
      const snapshot = success(await fixture.read(request), 'diff_snapshot')
      expect(snapshot.files.map(file => file.path)).toEqual(['.github/workflows/check.yml'])
      const forged = fixture.command(fileRequest(snapshot, byPath(snapshot, '.github/workflows/check.yml')))
      if (forged.request.kind !== 'diff_file') throw new Error('fixture request')
      forged.request.file.path = '.env'
      expect(await readWorkspaceDiffReceipt(forged, fixture.entry(), fixture.repository))
        .toEqual({ result: { ok: false, code: 'workspace_invalid_request' }, files: [] })
    }
  })

  it('fails closed for non-UTF-8 Git paths rather than collapsing different byte names into one path', async () => {
    const path = (byte: number) => Buffer.concat([Buffer.from(`${fixture.root}/invalid-`), Buffer.from([byte]), Buffer.from('.ts')])
    writeFileSync(path(0xfe), 'first original\n'); writeFileSync(path(0xff), 'second original\n')
    const baseSha = fixture.commit('seed two distinct byte filenames')
    writeFileSync(path(0xfe), 'first changed\n')
    const headSha = fixture.commit('change only one byte filename')
    expect(execFileSync('git', ['diff', '--name-only', '-z', baseSha, headSha], { cwd: fixture.root }))
      .toEqual(Buffer.concat([Buffer.from('invalid-'), Buffer.from([0xfe]), Buffer.from('.ts\0')]))
    for (const request of [{ kind: 'diff_snapshot', source: 'working' }, { kind: 'diff_snapshot', source: 'commit', baseSha, headSha }]) {
      const receipt = await fixture.read(request)
      expect(receipt.result.ok).toBe(false)
      expect(receipt.files).toEqual([]); expect(receipt.blobs ?? []).toEqual([])
    }
  })

  it('does not invent a same-commit gitlink change or read a changed gitlink as a blob', async () => {
    git(fixture.root, 'update-index', '--add', '--cacheinfo', `160000,${fixture.baseSha},dependency`)
    git(fixture.root, 'commit', '-qm', 'seed gitlink')
    const baseSha = git(fixture.root, 'rev-parse', 'HEAD')
    const unchanged = success(await fixture.read({ kind: 'diff_snapshot', source: 'commit', baseSha, headSha: baseSha }), 'diff_snapshot')
    expect(unchanged.files).toEqual([])
    git(fixture.root, 'update-index', '--cacheinfo', `160000,${baseSha},dependency`)
    git(fixture.root, 'commit', '-qm', 'advance gitlink')
    const headSha = git(fixture.root, 'rev-parse', 'HEAD')
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'commit', baseSha, headSha }), 'diff_snapshot')
    const file = byPath(snapshot, 'dependency')
    expect(file).toMatchObject({ oldMode: '160000', newMode: '160000', oldBlob: fixture.baseSha, newBlob: baseSha })
    const receipt = await fixture.read(fileRequest(snapshot, file))
    expect(success(receipt, 'diff_file')).toMatchObject({ format: 'unavailable', patch: null, hunks: [] })
    expect(receipt.files).toEqual([]); expect(receipt.blobs ?? []).toEqual([])
  })

  it('uses the registered clone when the worktree .git file points at a different repository', async () => {
    const foreign = await makeRepo()
    git(foreign, 'remote', 'add', 'origin', remote)
    writeFileSync(join(foreign, 'README.md'), 'foreign repository must not provide the frozen base')
    git(foreign, 'add', '--all'); git(foreign, 'commit', '-qm', 'foreign history')
    writeFileSync(join(fixture.root, '.git'), `gitdir: ${join(foreign, '.git')}\n`)
    fixture.write('tracked.txt', 'actual authorized checkout contents\n')
    const beforeForeign = directoryState(foreign)
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    expect(snapshot.revision).toMatchObject({ baseSha: fixture.baseSha, headSha: fixture.baseSha })
    const receipt = await fixture.read(fileRequest(snapshot, byPath(snapshot, 'tracked.txt')))
    expect([...proofs(receipt).values()].map(bytes => bytes.toString())).toEqual(['frozen base\n', 'actual authorized checkout contents\n'])
    expect(directoryState(foreign)).toEqual(beforeForeign)
    expect(readFileSync(join(fixture.root, '.git'), 'utf8')).toBe(`gitdir: ${join(foreign, '.git')}\n`)
  })

  it('marks a custom clean filter unavailable without executing it, textconv or external diff', async () => {
    const marker = join(fixture.directory, 'filter-executed')
    fixture.write('.gitattributes', 'tracked.txt filter=workspace-probe diff=workspace-probe\n')
    git(fixture.root, 'add', '--', '.gitattributes')
    git(fixture.root, 'config', 'filter.workspace-probe.clean', `printf executed >> '${marker}'; cat`)
    git(fixture.root, 'config', 'filter.workspace-probe.required', 'true')
    git(fixture.root, 'config', 'diff.workspace-probe.textconv', `printf executed >> '${marker}'; cat`)
    git(fixture.root, 'config', 'diff.external', `printf executed >> '${marker}'`)
    fixture.write('tracked.txt', 'read me without a filter\n')
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const file = byPath(snapshot, 'tracked.txt')
    expect(file.status).toBe('unavailable')
    const receipt = await fixture.read(fileRequest(snapshot, file))
    expect(success(receipt, 'diff_file')).toMatchObject({ format: 'unavailable', patch: null, hunks: [] })
    expect(receipt.files).toEqual([]); expect(receipt.blobs ?? []).toEqual([])
    expect(existsSync(marker)).toBe(false)
    // Positive control after the protected read: Git really would run this
    // clean filter if the implementation staged/hashed through attributes.
    execFileSync('git', ['hash-object', '--path=tracked.txt', '--stdin'], { cwd: fixture.root, input: 'control\n', stdio: ['pipe', 'pipe', 'pipe'] })
    expect(readFileSync(marker, 'utf8')).toBe('executed')
  })

  it.each(['working-tree-encoding=UTF-16', 'ident'])(
    'marks %s unavailable instead of inventing an unconverted blob proof', async attribute => {
      fixture.write('.gitattributes', `tracked.txt ${attribute}\n`)
      fixture.write('tracked.txt', attribute === 'ident' ? '$Id: expanded working copy $\n' : Buffer.from('encoding fixture\n', 'utf16le'))
      const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
      const file = byPath(snapshot, 'tracked.txt')
      expect(file.status).toBe('unavailable')
      const receipt = await fixture.read(fileRequest(snapshot, file))
      expect(success(receipt, 'diff_file')).toMatchObject({ format: 'unavailable', patch: null, hunks: [] })
      expect(receipt.files).toEqual([]); expect(receipt.blobs ?? []).toEqual([])
    })

  it('does not change the actual index, refs, object store or any worktree file', async () => {
    fixture.write('tracked.txt', 'staged version\n'); git(fixture.root, 'add', '--', 'tracked.txt')
    fixture.write('tracked.txt', 'unstaged final version\n'); fixture.write('new.txt', 'untracked version\n')
    const before = { clone: directoryState(fixture.repository), worktree: directoryState(fixture.root) }
    const snapshot = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    for (const file of snapshot.files) proofs(await fixture.read(fileRequest(snapshot, file)))
    expect({ clone: directoryState(fixture.repository), worktree: directoryState(fixture.root) }).toEqual(before)
  })

  it('invalidates an old manifest after another file changes while preserving the unchanged file version', async () => {
    fixture.write('a.txt', 'selected bytes\n'); fixture.write('z.txt', 'other original bytes\n')
    const first = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    const request = fileRequest(first, byPath(first, 'a.txt'))
    fixture.write('z.txt', 'other changed bytes\n')
    expect(await fixture.read(request)).toEqual({ result: { ok: false, code: 'workspace_version_conflict' }, files: [] })
    const second = success(await fixture.read({ kind: 'diff_snapshot', source: 'working' }), 'diff_snapshot')
    expect(second.revision.version).not.toBe(first.revision.version)
    expect(byPath(second, 'a.txt').fileVersion).toBe(byPath(first, 'a.txt').fileVersion)
    expect(proofs(await fixture.read(fileRequest(second, byPath(second, 'a.txt')))).get(blobId('selected bytes\n'))).toEqual(Buffer.from('selected bytes\n'))
  })

  it('rejects a changed HEAD during a real file read without returning partial proof', async () => {
    fixture.write('tracked.txt', 'observed bytes\n')
    let advanced = false
    await afterFileRead(path => {
      if (advanced || path !== join(fixture.root, 'tracked.txt')) return
      advanced = true; git(fixture.root, 'commit', '--allow-empty', '-qm', 'concurrent HEAD advance')
    })
    expect(await fixture.read({ kind: 'diff_snapshot', source: 'working' }))
      .toEqual({ result: { ok: false, code: 'workspace_version_conflict' }, files: [] })
    expect(advanced).toBe(true)
    expect(git(fixture.root, 'rev-parse', 'HEAD')).not.toBe(fixture.baseSha)
  })

  it('rejects a manifest whose earlier member changes while a later member is read', async () => {
    fixture.write('a.txt', 'before\n'); fixture.write('z.txt', 'last\n')
    let changed = false
    await afterFileRead(path => {
      if (changed || path !== join(fixture.root, 'z.txt')) return
      changed = true; fixture.write('a.txt', 'after!\n')
    })
    expect(await fixture.read({ kind: 'diff_snapshot', source: 'working' }))
      .toEqual({ result: { ok: false, code: 'workspace_version_conflict' }, files: [] })
    expect(changed).toBe(true)
  })

  it('does not publish a snapshot after its deadline passes during a real read', async () => {
    fixture.write('tracked.txt', 'deadline observed bytes\n')
    const command = fixture.command({ kind: 'diff_snapshot', source: 'working' })
    const startedAt = Date.now(), expiresAt = Date.parse(command.expiresAt)
    let clock = startedAt, expired = false
    vi.spyOn(Date, 'now').mockImplementation(() => clock)
    await afterFileRead(path => {
      if (path !== join(fixture.root, 'tracked.txt')) return
      expired = true; clock = expiresAt + 1
    })
    const receipt = await readWorkspaceDiffReceipt(command, fixture.entry(), fixture.repository)
    expect(receipt).toEqual({ result: { ok: false, code: 'workspace_request_expired' }, files: [] })
    expect(expired).toBe(true)
  })
})
