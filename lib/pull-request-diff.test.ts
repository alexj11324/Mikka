import assert from 'node:assert/strict'
import test from 'node:test'
import { pullRequestDiffText } from './pull-request-diff'
import { parseUnifiedDiff } from './thread-changes'

const hunk = '@@ -1,2 +1,3 @@\n context\n-removed\n+added\n+and this\n'

test('a modified file keeps its path and line counts through the diff the page parses', () => {
  const changes = parseUnifiedDiff(pullRequestDiffText([
    { path: 'lib/app.ts', previousPath: null, status: 'modified', patch: hunk },
  ]))
  assert.deepEqual(changes.files.map(file => [file.path, file.previousPath, file.status]), [['lib/app.ts', null, 'modified']])
  assert.deepEqual([changes.additions, changes.deletions], [2, 1])
  assert.deepEqual(changes.files[0].blocks.filter(block => block.kind === 'line').map(block => block.kind === 'line' && block.line.kind),
    ['context', 'removed', 'added', 'added'])
})

test('added, deleted and renamed files carry the status the diff has to draw', () => {
  const changes = parseUnifiedDiff(pullRequestDiffText([
    { path: 'new/file.ts', previousPath: null, status: 'added', patch: '@@ -0,0 +1,1 @@\n+first\n' },
    { path: 'gone/old.ts', previousPath: null, status: 'deleted', patch: '@@ -1,1 +0,0 @@\n-last\n' },
    { path: 'renamed/to.ts', previousPath: 'renamed/from.ts', status: 'renamed', patch: null },
  ]))
  assert.deepEqual(changes.files.map(file => [file.path, file.previousPath, file.status]),
    [['new/file.ts', null, 'added'], ['gone/old.ts', null, 'deleted'], ['renamed/to.ts', 'renamed/from.ts', 'renamed']])
})

test('a file GitHub sent no patch for still lists, with no lines and no invented counts', () => {
  const changes = parseUnifiedDiff(pullRequestDiffText([
    { path: 'asset/logo.png', previousPath: null, status: 'modified', patch: null },
  ]))
  assert.equal(changes.files.length, 1)
  assert.equal(changes.files[0].binary, true)
  assert.deepEqual(changes.files[0].blocks, [])
  assert.deepEqual([changes.additions, changes.deletions], [0, 0])
})

test('no files is an empty diff, not a broken one', () => {
  assert.equal(pullRequestDiffText([]), '')
  assert.deepEqual(parseUnifiedDiff(pullRequestDiffText([])), { files: [], additions: 0, deletions: 0 })
})
