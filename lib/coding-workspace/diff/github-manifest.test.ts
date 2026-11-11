import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { CodingWorkspaceError } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_MAX_FILES, WorkspaceReviewError, diffFileMetadata } from '@mikka/protocol/coding-workspace-review'
import {
  buildGitHubManifest, parseGitHubTree, type GitHubNativeFile, type GitHubTreeEntry,
} from './github-manifest'

const treeSha = 'a'.repeat(40), baseSha = 'b'.repeat(40), headSha = 'c'.repeat(40)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
function blob(value: string | Buffer, mode = '100644'): GitHubTreeEntry {
  const bytes = Buffer.from(value)
  return { sha: createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'), mode, size: bytes.length }
}
const tree = (entries: Array<[string, GitHubTreeEntry]>) => new Map(entries)
const envelope = (entries: unknown[]) => ({ sha: treeSha, url: `https://api.github.com/repos/fixture/repo/git/trees/${treeSha}`,
  truncated: false, tree: entries })
const rawBlob = (path: string, value = 'source\n', mode = '100644') => ({ path, type: 'blob', ...blob(value, mode) })
function input(before: Map<string, GitHubTreeEntry>, after: Map<string, GitHubTreeEntry>) {
  return { repoId: randomUUID(), repositoryId: '61393725', baseSha, headSha, before, after }
}
function native(path: string, status: GitHubNativeFile['status'], entry: GitHubTreeEntry,
  change: Partial<GitHubNativeFile> = {}): GitHubNativeFile {
  return { path, previousPath: null, status, sha: entry.sha,
    additions: status === 'removed' ? 0 : 1, deletions: status === 'added' ? 0 : 1,
    patchSha256: digest(`native patch for ${path}`), page: 1, ...change }
}
function denied(action: () => unknown, message?: string) {
  assert.throws(action, error => (error instanceof WorkspaceReviewError && error.code === 'workspace_snapshot_unavailable')
    || (error instanceof CodingWorkspaceError && ['workspace_path_unavailable', 'workspace_limit_exceeded'].includes(error.code)), message)
}
function pullRequestFixture() {
  const before = tree([
    ['src/modify.ts', blob('old\n')], ['src/delete.ts', blob('removed\n')],
    ['src/rename-from.ts', blob('original name\n')], ['src/unchanged.ts', blob('same\n')],
    ['.env', blob('unchanged private fixture\n')],
  ])
  const after = tree([
    ['src/modify.ts', blob('new\n')], ['src/add.ts', blob('added\n')],
    ['src/rename-to.ts', blob('renamed and edited\n')], ['src/unchanged.ts', blob('same\n')],
    ['.env', blob('unchanged private fixture\n')],
  ])
  return { ...input(before, after), nativeFiles: [
    native('src/modify.ts', 'modified', after.get('src/modify.ts')!),
    native('src/delete.ts', 'removed', before.get('src/delete.ts')!),
    native('src/add.ts', 'added', after.get('src/add.ts')!),
    native('src/rename-to.ts', 'renamed', after.get('src/rename-to.ts')!, { previousPath: 'src/rename-from.ts', page: 2 }),
  ] }
}

test('a native rename cannot hide both overwritten destination content and recreated source content', () => {
  const oldSource = blob('old-a\n'), oldDestination = blob('old-b\n'), newSource = blob('new-a\n')
  const value = input(tree([['a.txt', oldSource], ['b.txt', oldDestination]]),
    tree([['a.txt', newSource], ['b.txt', oldSource]]))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [native('b.txt', 'renamed', oldSource,
    { previousPath: 'a.txt', additions: 0, deletions: 0, patchSha256: null })] }),
  'covering both path names still omits the old b.txt blob and the new a.txt blob')
})

test('a native rename source still present after the change needs independent new-side evidence', () => {
  const original = blob('original source\n'), replacement = blob('replacement source\n')
  const value = input(tree([['source.txt', original]]), tree([['source.txt', replacement], ['destination.txt', original]]))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [native('destination.txt', 'renamed', original,
    { previousPath: 'source.txt', additions: 0, deletions: 0, patchSha256: null })] }),
  'the rename proves the original source and new destination, not the recreated source')
})

test('a native rename destination already present before the change needs independent old-side evidence', () => {
  const original = blob('original source\n'), overwritten = blob('overwritten destination\n')
  const value = input(tree([['source.txt', original], ['destination.txt', overwritten]]), tree([['destination.txt', original]]))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [native('destination.txt', 'renamed', original,
    { previousPath: 'source.txt', additions: 0, deletions: 0, patchSha256: null })] }),
  'the rename proves the original source and new destination, not the overwritten destination')
})

test('complete GitHub trees retain exact blob and gitlink identities while omitting validated directories', () => {
  const ordinary = rawBlob('src/普通 code.ts'), executable = rawBlob('bin/run', 'run\n', '100755')
  const symlink = rawBlob('src/link', '../target', '120000'), empty = rawBlob('empty.txt', '')
  const link = { path: 'vendor/component', type: 'commit', mode: '160000', sha: 'd'.repeat(40) }
  const value = envelope([
    { path: 'src', type: 'tree', mode: '040000', sha: 'e'.repeat(40) }, ordinary,
    { path: 'bin', type: 'tree', mode: '040000', sha: 'f'.repeat(40) }, executable,
    { path: 'vendor', type: 'tree', mode: '040000', sha: '1'.repeat(40) }, link,
    symlink, empty, rawBlob('.env', 'unchanged private fixture\n'),
  ])
  const original = structuredClone(value), parsed = parseGitHubTree(value, treeSha)
  assert.deepEqual([...parsed.keys()].sort(), ['.env', 'bin/run', 'empty.txt', 'src/link', 'src/普通 code.ts', 'vendor/component'].sort())
  assert.deepEqual(parsed.get(ordinary.path), blob('source\n'))
  assert.deepEqual(parsed.get(executable.path), blob('run\n', '100755'))
  assert.deepEqual(parsed.get(symlink.path), blob('../target', '120000'))
  assert.deepEqual(parsed.get('empty.txt'), blob(''))
  assert.deepEqual(parsed.get(link.path), { sha: link.sha, mode: '160000', size: null })
  assert.deepEqual(value, original)
})

test('truncated, unbound or malformed tree envelopes cannot stand in for a complete immutable tree', () => {
  const good = envelope([rawBlob('source.ts')])
  for (const value of [
    { ...good, truncated: true }, { ...good, truncated: undefined },
    { ...good, sha: 'd'.repeat(40) }, { ...good, sha: 'invalid' },
    { ...good, tree: null }, { ...good, tree: {} }, null, [],
  ]) denied(() => parseGitHubTree(value, treeSha))
  denied(() => parseGitHubTree(good, 'e'.repeat(40)))
  denied(() => parseGitHubTree({ ...good, sha: 'invalid' }, 'invalid'))
})

test('all tree paths, including omitted directory entries, must be relative, unique and structurally consistent', () => {
  for (const path of ['', '.', '..', '../outside', 'src/../outside', '/absolute', 'C:/absolute', 'src\\file',
    'src//file', 'src/./file', 'source\0.ts', 'source\n.ts', 'x'.repeat(1025)]) {
    for (const entry of [rawBlob(path), { path, type: 'tree', mode: '040000', sha: 'd'.repeat(40) }])
      denied(() => parseGitHubTree(envelope([entry]), treeSha))
  }
  for (const entries of [
    [rawBlob('same.ts'), rawBlob('same.ts', 'different\n')],
    [{ path: 'src', type: 'tree', mode: '040000', sha: 'd'.repeat(40) }, rawBlob('src')],
    [rawBlob('parent'), rawBlob('parent/child.ts')],
    [rawBlob('parent/child.ts'), rawBlob('parent')],
    [{ path: 'parent', type: 'commit', mode: '160000', sha: 'd'.repeat(40) }, rawBlob('parent/child.ts')],
  ]) denied(() => parseGitHubTree(envelope(entries), treeSha))
})

test('tree type, canonical Git mode, object ID and byte size must agree', () => {
  const good = rawBlob('source.ts')
  for (const change of [
    { type: 'tree' }, { type: 'commit' }, { type: 'unknown' }, { mode: '040000' }, { mode: '160000' },
    { mode: '100600' }, { mode: '100644 ', type: 'blob' },
    { sha: 'invalid' }, { sha: 'A'.repeat(40) }, { sha: '' },
    { size: -1 }, { size: 1.5 }, { size: Number.MAX_SAFE_INTEGER + 1 }, { size: '7' },
  ]) denied(() => parseGitHubTree(envelope([{ ...good, ...change }]), treeSha))
  denied(() => parseGitHubTree(envelope([{ path: 'directory', type: 'tree', mode: '100644', sha: 'd'.repeat(40) }]), treeSha))
  denied(() => parseGitHubTree(envelope([{ path: 'submodule', type: 'commit', mode: '100644', sha: 'd'.repeat(40) }]), treeSha))
  assert.equal(parseGitHubTree(envelope([]), treeSha).size, 0)
})

test('explicit commits enumerate every tree change, including mode-only changes, without native PR evidence', () => {
  const same = blob('same\n'), old = blob('old\n'), added = blob('added\n'), executable = blob('same\n', '100755')
  const value = input(tree([
    ['unchanged.ts', same], ['modified.ts', old], ['deleted.ts', blob('deleted\n')],
    ['mode.sh', same], ['old-name.ts', blob('move without edits\n')],
  ]), tree([
    ['unchanged.ts', same], ['modified.ts', blob('new\n')], ['added.ts', added],
    ['mode.sh', executable], ['new-name.ts', blob('move without edits\n')],
  ]))
  const original = structuredClone(value), files = buildGitHubManifest(value), byPath = new Map(files.map(file => [file.path, file]))
  assert.deepEqual([...byPath.keys()].sort(), ['added.ts', 'deleted.ts', 'mode.sh', 'modified.ts', 'new-name.ts'])
  assert.equal(byPath.get('added.ts')!.status, 'added'); assert.equal(byPath.get('added.ts')!.oldBlob, null)
  assert.equal(byPath.get('added.ts')!.newBlob, added.sha); assert.equal(byPath.get('added.ts')!.newSize, added.size)
  assert.equal(byPath.get('deleted.ts')!.status, 'deleted'); assert.equal(byPath.get('deleted.ts')!.newBlob, null)
  assert.equal(byPath.get('modified.ts')!.oldBlob, old.sha); assert.equal(byPath.get('modified.ts')!.status, 'modified')
  assert.equal(byPath.get('mode.sh')!.oldBlob, byPath.get('mode.sh')!.newBlob)
  assert.equal(byPath.get('mode.sh')!.oldMode, '100644'); assert.equal(byPath.get('mode.sh')!.newMode, '100755')
  assert.equal(byPath.get('new-name.ts')!.status, 'renamed'); assert.equal(byPath.get('new-name.ts')!.previousPath, 'old-name.ts')
  for (const file of files) {
    assert.ok(diffFileMetadata.safeParse(file).success)
    assert.deepEqual(file.github, { repositoryId: value.repositoryId, patchSha256: null, page: null })
    assert.match(file.fileVersion, /^[a-f0-9]{64}$/)
  }
  assert.deepEqual(value, original)
})

test('explicit commit rename inference requires unambiguous exact content and mode', () => {
  const original = blob('original\n'), edited = blob('edited\n')
  const changed = buildGitHubManifest(input(tree([['old.ts', original]]), tree([['new.ts', edited]])))
  assert.deepEqual(changed.map(file => [file.path, file.status, file.previousPath]).sort(),
    [['new.ts', 'added', null], ['old.ts', 'deleted', null]])
  const differentMode = buildGitHubManifest(input(tree([['old.ts', original]]), tree([['new.ts', { ...original, mode: '100755' }]])))
  assert.equal(differentMode.length, 2); assert.ok(differentMode.every(file => file.previousPath === null))
  const ambiguous = buildGitHubManifest(input(tree([['old-one.ts', original], ['old-two.ts', original]]), tree([['new.ts', original]])))
  assert.equal(ambiguous.length, 3); assert.ok(ambiguous.every(file => file.previousPath === null))
})

test('native PR renames preserve previousPath even when both the path and contents change', () => {
  const value = pullRequestFixture(), original = structuredClone(value)
  const files = buildGitHubManifest(value), byPath = new Map(files.map(file => [file.path, file]))
  assert.deepEqual([...byPath.keys()].sort(), ['src/add.ts', 'src/delete.ts', 'src/modify.ts', 'src/rename-to.ts'])
  const renamed = byPath.get('src/rename-to.ts')!
  assert.equal(renamed.status, 'renamed'); assert.equal(renamed.previousPath, 'src/rename-from.ts')
  assert.equal(renamed.oldBlob, value.before.get('src/rename-from.ts')!.sha)
  assert.equal(renamed.newBlob, value.after.get('src/rename-to.ts')!.sha)
  assert.notEqual(renamed.oldBlob, renamed.newBlob)
  for (const file of files) {
    const proof = value.nativeFiles.find(item => item.path === file.path)!
    assert.equal(file.additions, proof.additions); assert.equal(file.deletions, proof.deletions)
    assert.deepEqual(file.github, { repositoryId: value.repositoryId, patchSha256: proof.patchSha256, page: proof.page })
    assert.ok(diffFileMetadata.safeParse(file).success)
  }
  assert.equal(byPath.get('src/delete.ts')!.status, 'deleted')
  assert.deepEqual(value, original)
})

test('whole-PR coverage rejects a missing native file, an extra unchanged file, and duplicate paths', () => {
  const value = pullRequestFixture()
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [] }))
  for (let index = 0; index < value.nativeFiles.length; index++)
    denied(() => buildGitHubManifest({ ...value, nativeFiles: value.nativeFiles.filter((_, i) => i !== index) }))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [...value.nativeFiles,
    native('src/unchanged.ts', 'modified', value.after.get('src/unchanged.ts')!)] }))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [...value.nativeFiles, { ...value.nativeFiles[0]! }] }))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [...value.nativeFiles,
    native('not-in-either-tree.ts', 'added', blob('invented\n'))] }))
})

test('native blob IDs and statuses must match the exact changed sides of the immutable trees', () => {
  const value = pullRequestFixture()
  for (let index = 0; index < value.nativeFiles.length; index++) {
    const files = value.nativeFiles.map(file => ({ ...file })); files[index]!.sha = '0'.repeat(40)
    denied(() => buildGitHubManifest({ ...value, nativeFiles: files }))
  }
  for (const [path, status] of [
    ['src/modify.ts', 'added'], ['src/modify.ts', 'removed'], ['src/add.ts', 'modified'],
    ['src/delete.ts', 'modified'], ['src/rename-to.ts', 'added'],
  ] as const) denied(() => buildGitHubManifest({ ...value,
    nativeFiles: value.nativeFiles.map(file => file.path === path ? { ...file, status } : file) }))
  const rename = value.nativeFiles.find(file => file.status === 'renamed')!
  denied(() => buildGitHubManifest({ ...value, nativeFiles: value.nativeFiles.map(file => file === rename
    ? { ...file, sha: value.before.get(file.previousPath!)!.sha } : file) }))
})

test('previousPath is required only for a real rename and cannot reuse or invent a removed source', () => {
  const value = pullRequestFixture()
  for (const previousPath of [null, 'src/rename-to.ts', 'src/unchanged.ts', 'src/modify.ts', 'not-in-base.ts', '../outside'])
    denied(() => buildGitHubManifest({ ...value, nativeFiles: value.nativeFiles.map(file => file.status === 'renamed'
      ? { ...file, previousPath } : file) }))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: value.nativeFiles.map(file => file.status === 'modified'
    ? { ...file, previousPath: 'src/rename-from.ts' } : file) }))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: value.nativeFiles.map(file => file.status === 'added'
    ? { ...file, status: 'renamed', previousPath: 'src/rename-from.ts' } : file) }))
})

test('protected paths may remain unchanged in a full tree but no actual change can be silently dropped', () => {
  const privateEntry = blob('unchanged private fixture\n')
  const before = parseGitHubTree(envelope([rawBlob('.env', 'unchanged private fixture\n'), rawBlob('source.ts', 'old\n')]), treeSha)
  const after = parseGitHubTree(envelope([rawBlob('.env', 'unchanged private fixture\n'), rawBlob('source.ts', 'new\n')]), treeSha)
  const safe = buildGitHubManifest(input(before, after))
  assert.deepEqual(safe.map(file => file.path), ['source.ts'])
  for (const path of ['.env', 'keys/private.pem', 'nested/.ssh/id_rsa', '.git/config', 'config/secrets.json',
    'node_modules/pkg/index.js', 'src/.hidden.ts']) {
    for (const value of [
      input(new Map(), tree([[path, privateEntry]])),
      input(tree([[path, privateEntry]]), new Map()),
      input(tree([[path, privateEntry]]), tree([[path, blob('changed private fixture\n')]])),
    ]) denied(() => buildGitHubManifest(value), 'a protected change invalidates the complete capture')
  }
  const changedPrivate = input(tree([['.env', privateEntry]]), tree([['.env', blob('changed\n')]]))
  denied(() => buildGitHubManifest({ ...changedPrivate, nativeFiles: [native('.env', 'modified', changedPrivate.after.get('.env')!)] }))
  denied(() => buildGitHubManifest({ ...changedPrivate, nativeFiles: [] }), 'omitting the protected native file cannot certify completeness')
})

test('a rename cannot launder a protected previousPath into a visible destination', () => {
  const entry = blob('protected content fixture\n'), value = input(tree([['.env', entry]]), tree([['public.ts', entry]]))
  denied(() => buildGitHubManifest(value))
  denied(() => buildGitHubManifest({ ...value, nativeFiles: [native('public.ts', 'renamed', entry, { previousPath: '.env' })] }))
})

test('binary candidates and gitlink or symlink changes retain honest identities without pretending to read bytes', () => {
  const binaryBefore = blob(Buffer.from([0, 1, 2])), binaryAfter = blob(Buffer.from([0, 3, 4, 5]))
  const moduleBefore = { mode: '160000', sha: 'd'.repeat(40), size: null }
  const moduleAfter = { mode: '160000', sha: 'e'.repeat(40), size: null }
  const before = tree([['image.bin', binaryBefore], ['vendor/component', moduleBefore], ['link', blob('../old', '120000')]])
  const after = tree([['image.bin', binaryAfter], ['vendor/component', moduleAfter], ['link', blob('../new', '120000')]])
  const value = { ...input(before, after), nativeFiles: [
    native('image.bin', 'modified', binaryAfter, { additions: 0, deletions: 0, patchSha256: null, page: 2 }),
    native('vendor/component', 'modified', moduleAfter), native('link', 'modified', after.get('link')!),
  ] }
  const files = buildGitHubManifest(value), byPath = new Map(files.map(file => [file.path, file]))
  const binary = byPath.get('image.bin')!
  assert.equal(binary.binary, false, 'tree metadata alone cannot determine whether complete bytes are binary')
  assert.equal(binary.oldBlob, binaryBefore.sha); assert.equal(binary.newBlob, binaryAfter.sha)
  assert.equal(binary.oldSize, 3); assert.equal(binary.newSize, 4)
  assert.deepEqual(binary.github, { repositoryId: value.repositoryId, patchSha256: null, page: 2 })
  for (const [path, mode] of [['vendor/component', '160000'], ['link', '120000']] as const) {
    const file = byPath.get(path)!
    assert.equal(file.status, 'modified'); assert.equal(file.unavailableReason, 'file_type')
    assert.equal(file.oldMode, mode); assert.equal(file.newMode, mode)
    assert.equal(file.oldBlob, before.get(path)!.sha); assert.equal(file.newBlob, after.get(path)!.sha)
  }
  assert.equal(byPath.get('vendor/component')!.oldSize, null); assert.equal(byPath.get('vendor/component')!.newSize, null)
  assert.deepEqual(buildGitHubManifest(input(before, before)), [], 'an unchanged gitlink is not a modified file')
})

test('repository identity and native patch digest change Reviewed versions while a page locator does not', () => {
  const value = pullRequestFixture(), versions = (files: ReturnType<typeof buildGitHubManifest>) => new Map(files.map(file => [file.path, file.fileVersion]))
  const original = versions(buildGitHubManifest(value))
  const repositoryChanged = versions(buildGitHubManifest({ ...value, repositoryId: '61393726' }))
  for (const [path, version] of original) assert.notEqual(repositoryChanged.get(path), version)
  for (const patchSha256 of [digest('different native anchors'), null]) {
    const changed = versions(buildGitHubManifest({ ...value, nativeFiles: value.nativeFiles.map((file, index) => index === 0
      ? { ...file, patchSha256 } : file) }))
    assert.notEqual(changed.get(value.nativeFiles[0]!.path), original.get(value.nativeFiles[0]!.path))
    for (const file of value.nativeFiles.slice(1)) assert.equal(changed.get(file.path), original.get(file.path))
  }
  const moved = buildGitHubManifest({ ...value, nativeFiles: value.nativeFiles.map(file => ({ ...file, page: file.page + 1 })) })
  assert.deepEqual(versions(moved), original)
  for (const file of moved) assert.equal(file.github!.page, value.nativeFiles.find(item => item.path === file.path)!.page + 1)
  const explicit = { ...value, nativeFiles: undefined }
  const explicitVersions = versions(buildGitHubManifest(explicit))
  const otherRepository = versions(buildGitHubManifest({ ...explicit, repositoryId: '61393726' }))
  for (const [path, version] of explicitVersions) assert.notEqual(otherRepository.get(path), version)
})

test('manifest output is independent of tree and native page ordering and keeps private evidence out', () => {
  const value = pullRequestFixture(), expected = buildGitHubManifest(value)
  const reordered = buildGitHubManifest({ ...value, before: new Map([...value.before].reverse()),
    after: new Map([...value.after].reverse()), nativeFiles: [...value.nativeFiles].reverse() })
  assert.deepEqual(reordered, expected)
  const json = JSON.stringify(expected)
  assert.doesNotMatch(json, /"(?:before|after|base64|blobs|nativeFiles|patch)"/)
  assert.equal(json.includes('unchanged private fixture'), false)
  assert.deepEqual(buildGitHubManifest({ ...input(new Map(), new Map()), nativeFiles: [] }), [])
})

test('whole-PR page locators are bounded real pages, not arbitrary source selectors', () => {
  const value = pullRequestFixture()
  for (const page of [0, -1, 1.5, 31]) denied(() => buildGitHubManifest({ ...value,
    nativeFiles: value.nativeFiles.map((file, index) => index === 0 ? { ...file, page } : file) }))
})

test('native file count, total changed-file count and serialized manifest bytes have hard limits', () => {
  const entry = blob('')
  const prAfter = new Map(Array.from({ length: 3001 }, (_, index) => [`f${index.toString(36)}`, entry] as const))
  denied(() => buildGitHubManifest({ ...input(new Map(), prAfter), repositoryId: '1',
    nativeFiles: [...prAfter].map(([path, file]) => native(path, 'added', file, { additions: 0, patchSha256: null, page: 30 })) }))
  const manyFiles = new Map(Array.from({ length: WORKSPACE_DIFF_MAX_FILES + 1 }, (_, index) => [`f${index}`, entry] as const))
  denied(() => buildGitHubManifest(input(new Map(), manyFiles)))
  const longPaths = new Map(Array.from({ length: 1800 }, (_, index) => [`${'x'.repeat(900)}/${index}.ts`, entry] as const))
  assert.ok([...longPaths.keys()].reduce((size, path) => size + Buffer.byteLength(path), 0) > 1.5 * 1024 * 1024)
  denied(() => buildGitHubManifest(input(new Map(), longPaths)))
})
