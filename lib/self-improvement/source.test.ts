import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { BASELINE_MARKDOWN } from './builtin-skill'
import { SKILL_PATH } from './regression'
import { githubRepository, readCommittedSkill } from './source'

const sha = 'a'.repeat(40), baseSha = 'b'.repeat(40), treeSha = 'c'.repeat(40)
const source = { repository: 'https://github.com/example/public.git', sha, baseSha }
function fixture(options: { bytes?: Buffer; mode?: string; extraFile?: boolean; corruptBlob?: boolean; redirect?: boolean; oversize?: boolean; nonUtf8?: boolean } = {}) {
  const bytes = options.bytes ?? Buffer.from(BASELINE_MARKDOWN)
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
  const calls: string[] = []
  const segments = SKILL_PATH.split('/')
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const address = String(url); calls.push(address)
    assert.equal(init?.redirect, 'error')
    const headers = init?.headers as Record<string, string> | undefined
    assert.equal(headers?.Authorization, undefined)
    const root = 'https://api.github.com/repos/example/public'
    assert.ok(address.startsWith(root))
    const path = address.slice(root.length)
    let data: unknown
    if (!path) data = { full_name: 'example/public', private: false }
    else if (path.startsWith('/compare/')) data = { status: 'ahead', behind_by: 0, merge_base_commit: { sha: baseSha },
      total_commits: 1, commits: [{ sha }], files: [{ filename: SKILL_PATH, status: 'modified', sha: blobSha },
        ...(options.extraFile ? [{ filename: 'tests/scorer.ts', status: 'modified', sha }] : [])] }
    else if (path === `/git/commits/${sha}`) data = { sha, tree: { sha: treeSha } }
    else if (path.startsWith('/git/trees/')) {
      const index = path.endsWith(treeSha) ? 0 : Number(path.slice('/git/trees/'.length).at(-1))
      data = { sha: path.slice('/git/trees/'.length), truncated: false, tree: [{ path: segments[index],
        mode: index === segments.length - 1 ? options.mode ?? '100644' : '040000',
        type: index === segments.length - 1 ? 'blob' : 'tree',
        sha: index === segments.length - 1 ? blobSha : 'd'.repeat(39) + (index + 1), size: bytes.length }] }
    } else if (path === `/git/blobs/${blobSha}`) data = { sha: blobSha, size: bytes.length, encoding: 'base64',
      content: options.corruptBlob ? Buffer.from('wrong').toString('base64') : bytes.toString('base64') }
    else throw new Error('unexpected request')
    if (options.redirect) return new Response(null, { status: 302, headers: { location: 'https://other.invalid' } })
    if (options.nonUtf8) return new Response(new Uint8Array([0xff]))
    return new Response(JSON.stringify(data), { headers: options.oversize ? { 'content-length': '9000000' } : {} })
  }) as typeof fetch
  return { fetcher, calls }
}

test('reads exact public GitHub commit through fixed API endpoints and verifies raw blob bytes', async () => {
  const { fetcher, calls } = fixture()
  assert.equal(await readCommittedSkill(source, fetcher), BASELINE_MARKDOWN)
  assert.ok(calls.includes(`https://api.github.com/repos/example/public/compare/${baseSha}...${sha}`))
  assert.equal(githubRepository('git@github.com:example/public.git'), 'https://github.com/example/public')
  assert.equal(githubRepository('https://github.com/example/public'), 'https://github.com/example/public')
})

test('rejects repository URLs, credential forms, traversal and custom paths before fetching', async () => {
  for (const repository of ['https://evil.test/example/public', 'https://github.com@evil.test/a/b',
    'https://token@github.com/example/public', 'https://github.com/example/../public',
    'https://github.com/example/public/tree/main', 'https://github.com/example/public?token=x',
    'https://github.com/example/%2e%2e', 'git@evil.test:example/public', 'https://github.com/example/..']) {
    const { fetcher, calls } = fixture()
    await assert.rejects(readCommittedSkill({ ...source, repository }, fetcher), /sourceMismatch/)
    assert.equal(calls.length, 0)
  }
  await assert.rejects(readCommittedSkill({ ...source, path: '../SKILL.md' }, fixture().fetcher), /sourceMismatch/)
  await assert.rejects(readCommittedSkill({ ...source, sha: 'main' }, fixture().fetcher), /sourceMismatch/)
})

test('rejects redirects, oversized bodies, invalid UTF-8, extra files, nonregular entries and blob corruption', async () => {
  for (const options of [{ redirect: true }, { oversize: true }, { nonUtf8: true }, { extraFile: true },
    { mode: '120000' }, { mode: '100755' }, { corruptBlob: true }, { bytes: Buffer.from([0xff]) },
    { bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(BASELINE_MARKDOWN)]) }]) {
    await assert.rejects(readCommittedSkill(source, fixture(options).fetcher), /sourceRequired|sourceMismatch/)
  }
})

test('unavailable or private repository fails closed with a sanitized error', async () => {
  await assert.rejects(readCommittedSkill(source, (async () => { throw new Error('https://secret@transport') }) as typeof fetch), /^Error: sourceRequired$/)
  await assert.rejects(readCommittedSkill(source, (async () => new Response(JSON.stringify({ private: true, full_name: 'example/public' }))) as typeof fetch), /sourceMismatch/)
})
