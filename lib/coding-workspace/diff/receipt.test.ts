import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { workspaceReadReceipt, type RunWorktreeIdentity, type WorkspaceReadReceipt } from '@mikka/protocol/coding-workspace'
import { WORKSPACE_DIFF_MAX_BLOB_BYTES, type DiffFileMetadata, type DiffRevision,
  type WorkspaceDiffReadRequest } from '@mikka/protocol/coding-workspace-review'
import { createSecretMasker, identityMasker, withCredentialMasking, type Masker } from '../../secrets/mask'
import { validateWorkspaceReceipt } from '../receipt'
import { diffFileVersion } from './patch'

const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const objectId = (value: Buffer) => createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex')
type FileRequest = Extract<WorkspaceDiffReadRequest, { kind: 'diff_file' }>

function fixture(options: {
  before?: string | Buffer | null; raw?: string | Buffer; canonical?: string | Buffer;
  clean?: boolean; source?: 'working' | 'commit'; file?: Partial<DiffFileMetadata>;
} = {}) {
  const before = options.before === null ? null : Buffer.from(options.before ?? 'before\n')
  const raw = Buffer.from(options.raw ?? 'after\r\n'), canonical = Buffer.from(options.canonical ?? 'after\n')
  const clean = options.clean ?? true
  const identity: RunWorktreeIdentity = { version: 1, runId: randomUUID(), repoId: randomUUID(), deviceId: randomUUID(),
    workspaceId: randomUUID(), ownerId: 'diff-receipt-fixture-owner', repositoryKey: 'github.com/mikka-fixtures/receipt', bindingId: 'a'.repeat(64) }
  const revision: DiffRevision = { source: options.source ?? 'working', baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40),
    treeSha: options.source === 'commit' ? 'd'.repeat(40) : null, version: '0'.repeat(64) }
  const file: DiffFileMetadata = { path: 'example.txt', previousPath: null, status: before === null ? 'added' : 'modified',
    oldBlob: before === null ? null : objectId(before), newBlob: objectId(canonical),
    oldMode: before === null ? null : '100644', newMode: '100644', oldSize: before?.length ?? null, newSize: canonical.length,
    additions: 0, deletions: 0, binary: false, fileVersion: '0'.repeat(64),
    ...(clean ? { rawBlob: objectId(raw), rawSize: raw.length } : {}), ...options.file }
  file.fileVersion = diffFileVersion(identity.repoId, revision, file)
  revision.version = digest(JSON.stringify([revision.source, revision.baseSha, revision.headSha, revision.treeSha, [file.fileVersion]]))
  const request: FileRequest = { kind: 'diff_file', snapshotId: randomUUID(), revision, file }
  const proofs = new Map<string, NonNullable<WorkspaceReadReceipt['blobs']>[number]>()
  if (before && file.oldBlob) proofs.set(file.oldBlob, { sha: file.oldBlob, base64: before.toString('base64') })
  if (file.newBlob) proofs.set(file.newBlob, { sha: file.newBlob, base64: (clean ? raw : canonical).toString('base64'),
    ...(clean ? { clean: 'crlf_to_lf', rawSha: objectId(raw) } : {}) })
  const receipt: WorkspaceReadReceipt = { result: { ok: true, kind: 'diff_file', identity, revision,
    observedAt: '2026-11-08T12:00:00.000Z', availability: 'online', snapshotId: request.snapshotId,
    sourceVersion: revision.version, file, format: 'text', patch: null, hunks: [] }, files: [], blobs: [...proofs.values()] }
  return { identity, request, receipt, before, raw, canonical }
}

type Fixture = ReturnType<typeof fixture>
const validate = (value: Fixture, mask: Masker = identityMasker) =>
  validateWorkspaceReceipt(value.request, value.identity, value.receipt, mask)
const newProof = (value: Fixture) => value.receipt.blobs!.find(proof => proof.sha === value.request.file.newBlob)!

function changeFile(value: Fixture, change: Partial<DiffFileMetadata>) {
  value.request.file = { ...value.request.file, ...change }
  assert.ok(value.receipt.result.ok && value.receipt.result.kind === 'diff_file')
  value.receipt.result.file = { ...value.request.file }
}

test('a full raw proof yields a canonical patch while private proof bytes stay out of the public result', () => {
  const value = fixture({ before: '\uFEFFbefore\nlast', raw: '\uFEFFafter\r\nlast', canonical: '\uFEFFafter\nlast' })
  assert.ok(workspaceReadReceipt.safeParse(value.receipt).success)
  const untouched = structuredClone(value.receipt)
  const result = validate(value)
  assert.ok(result?.ok && result.kind === 'diff_file')
  assert.equal(result.format, 'text')
  assert.match(result.patch!, /\+\uFEFFafter\n/)
  assert.equal(result.patch!.includes('\r'), false)
  assert.equal(result.file.additions, 1); assert.equal(result.file.deletions, 1)
  assert.equal('blobs' in result || 'base64' in result || 'rawSha' in result || 'clean' in result, false)
  assert.equal(JSON.stringify(result).includes(value.raw.toString('base64')), false)
  assert.deepEqual(value.receipt, untouched, 'validation must not rewrite the received evidence')
})

test('registered CRLF and mixed-newline secrets in complete raw source block a hunk far away', () => {
  for (const secret of ['fixture-private-one\r\nfixture-private-two', 'fixture-private-one\r\nfixture-private-two\nfixture-private-three']) {
    const prefix = secret + '\r\n' + 'ordinary context\r\n'.repeat(30)
    const canonicalPrefix = prefix.replace(/\r\n/g, '\n')
    const value = fixture({ before: canonicalPrefix + 'old\n', raw: prefix + 'new\r\n', canonical: canonicalPrefix + 'new\n' })
    const publicWithoutMask = validate(value)
    assert.ok(publicWithoutMask?.ok && publicWithoutMask.kind === 'diff_file')
    assert.equal(publicWithoutMask.patch!.includes('fixture-private-'), false, 'the changed hunk does not contain the secret')
    const mask = withCredentialMasking(createSecretMasker([{ name: 'DIFF_PRIVATE', value: secret }]))
    assert.notEqual(mask(value.raw.toString('utf8')), value.raw.toString('utf8'))
    assert.deepEqual(validate(value, mask), { ok: false, code: 'workspace_path_unavailable' })
  }
})

test('LF and CRLF spellings of a registered full secret are rejected in canonical source too', () => {
  for (const [secret, source] of [
    ['fixture-private-one\nfixture-private-two', 'fixture-private-one\r\nfixture-private-two'],
    ['fixture-private-one\r\nfixture-private-two', 'fixture-private-one\nfixture-private-two'],
  ]) {
    const value = fixture({ raw: source! + '\n', canonical: source! + '\n', clean: false })
    const mask = withCredentialMasking(createSecretMasker([{ name: 'DIFF_PRIVATE', value: secret! }]))
    assert.deepEqual(validate(value, mask), { ok: false, code: 'workspace_path_unavailable' })
  }
})

test('old committed source is checked in full even when the new source removes the secret', () => {
  const secret = 'fixture-old-private-one\r\nfixture-old-private-two'
  const value = fixture({ before: secret.replace(/\r\n/g, '\n') + '\n', raw: 'public\n', canonical: 'public\n', clean: false, source: 'commit' })
  const mask = withCredentialMasking(createSecretMasker([{ name: 'OLD_PRIVATE', value: secret }]))
  assert.deepEqual(validate(value, mask), { ok: false, code: 'workspace_path_unavailable' })
})

test('a declared raw source cannot be omitted, replaced by canonical bytes or stripped of its binding', () => {
  const cases: Array<[string, (value: Fixture) => void]> = [
    ['missing new proof', value => { value.receipt.blobs = value.receipt.blobs!.filter(proof => proof.sha !== value.request.file.newBlob) }],
    ['canonical bytes without clean', value => {
      const proof = newProof(value); proof.base64 = value.canonical.toString('base64'); delete proof.clean; delete proof.rawSha
    }],
    ['clean flag without raw SHA', value => { delete newProof(value).rawSha }],
    ['raw SHA without clean flag', value => { delete newProof(value).clean }],
    ['missing metadata raw hash', value => { changeFile(value, { rawBlob: undefined }) }],
    ['missing metadata raw size', value => { changeFile(value, { rawSize: undefined }) }],
    ['unbound metadata raw hash', value => { changeFile(value, { rawBlob: 'e'.repeat(40) }) }],
  ]
  for (const [reason, corrupt] of cases) {
    const value = fixture(); corrupt(value)
    assert.equal(validate(value), null, reason)
  }
})

test('raw bytes, raw hash and the canonical hash are independently verified', () => {
  const forged = fixture()
  newProof(forged).base64 = Buffer.from('other\r\n').toString('base64')
  assert.equal(validate(forged), null, 'different raw bytes cannot retain the original raw hash')

  const wrongCanonical = fixture(), raw = Buffer.from('other\r\n'), rawSha = objectId(raw)
  newProof(wrongCanonical).base64 = raw.toString('base64'); newProof(wrongCanonical).rawSha = rawSha
  changeFile(wrongCanonical, { rawBlob: rawSha, rawSize: raw.length })
  assert.equal(validate(wrongCanonical), null, 'a correct raw hash does not authorize a different normalized blob')

  const lostCR = fixture({ raw: 'one\r\ntwo\rthree\n', canonical: 'one\ntwothree\n' })
  assert.equal(validate(lostCR), null, 'clean may remove CR only when immediately followed by LF')
  const retainedCR = fixture({ raw: 'one\r\ntwo\rthree\n', canonical: 'one\ntwo\rthree\n' })
  assert.ok(validate(retainedCR)?.ok, 'a lone CR is preserved by the permitted byte transformation')
})

test('all raw and canonical byte sizes must agree with their full proof', () => {
  for (const key of ['rawSize', 'newSize', 'oldSize'] as const) {
    const value = fixture()
    changeFile(value, { [key]: value.request.file[key]! + 1 })
    assert.equal(validate(value), null, key)
  }
})

test('clean cannot be applied to a distinct old blob or to an immutable commit result', () => {
  const old = fixture()
  const proof = old.receipt.blobs!.find(item => item.sha === old.request.file.oldBlob)!
  proof.clean = 'crlf_to_lf'; proof.rawSha = objectId(old.before!)
  assert.equal(validate(old), null, 'only the selected new working source can claim conversion')
  const committed = fixture({ source: 'commit' })
  assert.equal(validate(committed), null, 'Git object reads cannot claim working-tree clean conversion')
})

test('mode-only changes with identical canonical blobs need one deduplicated raw proof', () => {
  const value = fixture({ before: 'same\n', raw: 'same\r\n', canonical: 'same\n', file: { newMode: '100755' } })
  assert.equal(value.request.file.oldBlob, value.request.file.newBlob)
  assert.equal(value.receipt.blobs!.length, 1)
  const result = validate(value)
  assert.ok(result?.ok && result.kind === 'diff_file')
  assert.equal(result.format, 'text'); assert.deepEqual(result.hunks, [])
  assert.match(result.patch!, /old mode 100644\nnew mode 100755\n/)
  const canonicalOnly = structuredClone(value)
  canonicalOnly.receipt.blobs = [{ sha: value.request.file.newBlob!, base64: value.canonical.toString('base64') }]
  assert.equal(validate(canonicalOnly), null, 'deduplication must not discard the raw-source obligation')
})

test('receipt proof sets reject duplicates, unrelated objects and noncanonical base64 padding bits', () => {
  const duplicate = fixture({ before: null })
  duplicate.receipt.blobs!.push({ ...duplicate.receipt.blobs![0]! })
  assert.equal(validate(duplicate), null)
  const extra = fixture({ before: null }), unrelated = Buffer.from('unrelated\n')
  extra.receipt.blobs!.push({ sha: objectId(unrelated), base64: unrelated.toString('base64') })
  assert.equal(validate(extra), null)
  const padding = fixture({ before: 'a' })
  const proof = padding.receipt.blobs!.find(item => item.sha === padding.request.file.oldBlob)!
  assert.equal(Buffer.from('YR==', 'base64').toString(), 'a')
  proof.base64 = 'YR=='
  assert.equal(validate(padding), null, 'equivalent decoded bytes still require the canonical base64 spelling')
})

test('a raw source over the cap stays metadata-only even when canonical bytes fit', () => {
  const lines = WORKSPACE_DIFF_MAX_BLOB_BYTES / 2 + 1
  const value = fixture({ raw: '\r\n'.repeat(lines), canonical: '\n'.repeat(lines) })
  assert.ok(value.raw.length > WORKSPACE_DIFF_MAX_BLOB_BYTES)
  assert.ok(value.canonical.length <= WORKSPACE_DIFF_MAX_BLOB_BYTES)
  assert.equal(validate(value), null, 'oversized full-source bytes cannot enter the receipt')
  value.receipt.blobs = []
  const result = validate(value)
  assert.ok(result?.ok && result.kind === 'diff_file')
  assert.equal(result.format, 'too_large'); assert.equal(result.patch, null); assert.deepEqual(result.hunks, [])
})

test('byte-exact normalization of invalid UTF-8 yields only binary metadata', () => {
  const value = fixture({ raw: Buffer.from([0xff, 0xfe, 13, 10]), canonical: Buffer.from([0xff, 0xfe, 10]) })
  const result = validate(value)
  assert.ok(result?.ok && result.kind === 'diff_file')
  assert.equal(result.format, 'binary'); assert.equal(result.file.binary, true)
  assert.equal(result.patch, null); assert.deepEqual(result.hunks, [])
})

test('public diff identity, source version, file metadata and patch content cannot be substituted', () => {
  const cases: Array<[string, (value: Fixture) => void]> = [
    ['other owner', value => { if (value.receipt.result.ok) value.receipt.result.identity.ownerId = 'other-owner' }],
    ['other device', value => { if (value.receipt.result.ok) value.receipt.result.identity.deviceId = randomUUID() }],
    ['source version', value => { if (value.receipt.result.ok && value.receipt.result.kind === 'diff_file') value.receipt.result.sourceVersion = 'f'.repeat(64) }],
    ['file metadata', value => { if (value.receipt.result.ok && value.receipt.result.kind === 'diff_file') value.receipt.result.file.newSize = 1 }],
    ['device-authored patch', value => { if (value.receipt.result.ok && value.receipt.result.kind === 'diff_file') value.receipt.result.patch = '+forged public content\n' }],
  ]
  for (const [reason, corrupt] of cases) {
    const original = fixture(), value = { ...original, receipt: structuredClone(original.receipt) }
    corrupt(value)
    assert.equal(validate(value), null, reason)
  }
})

test('snapshot manifests reject private proofs, duplicate paths and forged version material', () => {
  const value = fixture(), request = { kind: 'diff_snapshot', source: 'working' } as const
  const receipt: WorkspaceReadReceipt = { result: { ok: true, kind: 'diff_snapshot', identity: value.identity, revision: value.request.revision,
    observedAt: '2026-11-08T12:00:00.000Z', availability: 'online', files: [value.request.file] }, files: [] }
  assert.deepEqual(validateWorkspaceReceipt(request, value.identity, receipt, identityMasker), receipt.result)
  assert.equal(validateWorkspaceReceipt(request, value.identity, { ...receipt, blobs: value.receipt.blobs }, identityMasker), null)
  const duplicate = structuredClone(receipt)
  assert.ok(duplicate.result.ok && duplicate.result.kind === 'diff_snapshot')
  duplicate.result.files.push({ ...duplicate.result.files[0]! })
  duplicate.result.revision.version = digest(JSON.stringify(['working', value.request.revision.baseSha, value.request.revision.headSha,
    null, duplicate.result.files.map(file => file.fileVersion)]))
  assert.equal(validateWorkspaceReceipt(request, value.identity, duplicate, identityMasker), null)
  const wrongFile = structuredClone(receipt)
  assert.ok(wrongFile.result.ok && wrongFile.result.kind === 'diff_snapshot')
  wrongFile.result.files[0]!.rawBlob = 'e'.repeat(40)
  assert.equal(validateWorkspaceReceipt(request, value.identity, wrongFile, identityMasker), null)
  const wrongRevision = structuredClone(receipt)
  assert.ok(wrongRevision.result.ok && wrongRevision.result.kind === 'diff_snapshot')
  wrongRevision.result.revision.version = 'e'.repeat(64)
  assert.equal(validateWorkspaceReceipt(request, value.identity, wrongRevision, identityMasker), null)
})
