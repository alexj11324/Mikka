import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { cleanupNativePublication, ownedPublicationCleanupScript, runtimeAssertionScript } from './coding-workspace-native.mjs'

const id = '00000000-0000-4000-8000-000000000001', commit = 'a'.repeat(40), baseCommit = 'b'.repeat(40)
const body = 'synthetic acceptance bytes\n', privateText = 'PRIVATE_NATIVE_OUTPUT_DO_NOT_REPORT'
const config = { repository: 'alexj11324/Mikka-handoff', issueId: id, candidateSha: commit, baseCommit,
  branch: 'mikka/test-1', prNumber: 31, filePath: `docs/coding-workspace/acceptance-${id}.txt`,
  fileSha256: createHash('sha256').update(body).digest('hex'), createdAfter: 1000000 }

function fixture({ alterPr = () => {}, changedBranch = false, badFile = false, extraFile = false, changedAuthor = false } = {}) {
  const calls = []; let closed = false, deleted = false, reads = 0
  const execute = async (program, args, settings) => {
    if (program === 'git') {
      assert.deepEqual(args.slice(0, 6), ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=!gh auth git-credential', '-c', 'credential.useHttpPath=true'])
      args = args.slice(6)
    }
    calls.push({ program, args }); assert.ok(settings.timeout > 0 && settings.timeout <= 15000)
    if (program === 'gh' && args[0] === 'api') {
      const path = args[1]; let value
      if (path === `repos/${config.repository}`) value = { full_name: config.repository, default_branch: 'main', permissions: { push: true } }
      else if (path.includes('/pulls/')) {
        reads++
        value = { number: config.prNumber, state: closed ? 'closed' : 'open', merged: false, merged_at: null,
          head: { ref: config.branch, sha: commit, repo: { full_name: config.repository } },
          base: { ref: 'main', repo: { full_name: config.repository } }, user: { id: changedAuthor && reads > 1 ? 93 : 91 },
          body: `${privateText}\n<!-- mikka-issue:${id} -->`, created_at: new Date(config.createdAfter + 1000).toISOString() }
        alterPr(value)
      } else if (path.includes('/contents/')) value = { type: 'file', path: config.filePath, encoding: 'base64', content: Buffer.from(badFile ? 'wrong' : body).toString('base64') }
      else if (path.includes('/compare/')) value = { status: 'ahead', merge_base_commit: { sha: baseCommit }, files: [
        { filename: config.filePath, status: 'added' }, ...(extraFile ? [{ filename: 'other', status: 'modified' }] : []),
      ] }
      else assert.fail('unexpected GitHub request')
      return { stdout: JSON.stringify(value) }
    }
    if (program === 'git' && args[0] === 'ls-remote') {
      const ref = args[2]
      if (ref === 'refs/heads/main') return { stdout: `${baseCommit}\t${ref}\n` }
      assert.equal(ref, 'refs/heads/' + config.branch)
      return { stdout: deleted ? '' : `${changedBranch && closed ? 'c'.repeat(40) : commit}\t${ref}\n` }
    }
    if (program === 'git' && args[0] === 'rev-parse') return { stdout: commit }
    if (program === 'gh' && args[0] === 'pr') {
      assert.deepEqual(args, ['pr', 'close', '31', '--repo', config.repository]); closed = true; return { stdout: privateText }
    }
    if (program === 'git' && args[0] === 'push') {
      assert.equal(closed, true)
      assert.deepEqual(args, ['push', `https://github.com/${config.repository}.git`, ':refs/heads/' + config.branch])
      deleted = true; return { stdout: privateText }
    }
    assert.fail('unexpected native command')
  }
  return { execute, calls, now: () => config.createdAfter + 10000 }
}

test('native cleanup proves exact new PR/file/head/author and closes before ordinary ref deletion', async () => {
  const f = fixture(), report = await cleanupNativePublication(config, f)
  assert.deepEqual(report, { status: 'passed', prNumber: 31, candidateSha: commit,
    prClosed: true, branchDeleted: true, defaultBranchUnchanged: true })
  assert.equal(JSON.stringify(report).includes(privateText), false)
  assert.equal(f.calls.some(call => call.args.some(arg => /force|merge|rebase/.test(arg))), false)
})

test('wrong repo, old PR, changed author/head/file or extra changes never authorize a cleanup write', async () => {
  for (const options of [
    { alterPr: pr => { pr.head.repo.full_name = 'other/repo' } },
    { alterPr: pr => { pr.created_at = '1970-01-01T00:00:00.000Z' } },
    { alterPr: pr => { pr.body = 'missing marker' } },
    { alterPr: pr => { pr.merged = true } }, { alterPr: pr => { pr.head.sha = baseCommit } },
    { changedAuthor: true }, { badFile: true }, { extraFile: true },
  ]) {
    const f = fixture(options)
    await assert.rejects(cleanupNativePublication(config, f), /workspace_review_publication_unconfirmed/)
    assert.equal(f.calls.some(call => call.program === 'git' && call.args[0] === 'push' || call.program === 'gh' && call.args[0] === 'pr'), false)
  }
})

test('a head changed after PR close is retained rather than deleting another writer’s commit', async () => {
  const f = fixture({ changedBranch: true })
  await assert.rejects(cleanupNativePublication(config, f), /workspace_review_publication_unconfirmed/)
  assert.equal(f.calls.filter(call => call.program === 'gh' && call.args[0] === 'pr').length, 1)
  assert.equal(f.calls.some(call => call.program === 'git' && call.args[0] === 'push'), false)
})

test('PTY commands are fixed scripts with bounded validated config and immutable runtime checks', () => {
  const script = ownedPublicationCleanupScript(config)
  assert.ok(script.startsWith('/opt/mikka/runtime/node/bin/node -e ')); assert.ok(Buffer.byteLength(script) <= 14000)
  assert.ok(script.includes('cleanupNativePublication')); assert.equal(script.includes(privateText), false)
  for (const change of [{ repository: 'other/repo' }, { branch: 'main; echo bad' }, { issueId: '../x' }, { prNumber: 0 }, { filePath: '../file' }])
    assert.throws(() => ownedPublicationCleanupScript({ ...config, ...change }), /workspace_review_native_scope/)
  const runtime = runtimeAssertionScript({ workerSha: commit, workerSourceCommit: baseCommit })
  assert.ok(runtime.includes('lstatSync')); assert.ok(runtime.includes('s.uid!==0')); assert.ok(runtime.includes('(s.mode&0o222)!==0'))
  assert.ok(runtime.includes(`/opt/mikka/releases/${baseCommit}/source`))
  assert.throws(() => runtimeAssertionScript({ workerSha: 'main', workerSourceCommit: baseCommit }))
})
