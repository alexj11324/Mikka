import assert from 'node:assert/strict'
import test from 'node:test'
import { gitLogArgs, gitLogFormat, historyCursor, parseGitLog, parseHistoryCursor, parsePorcelainV2 } from '../../../packages/daemon/src/coding-workspace/git-parse'

const sha = (letter: string) => letter.repeat(40)
const head = sha('a'), base = sha('b')

test('porcelain v2 keeps index/worktree states, renames and unmerged paths', () => {
  const output = [
    `# branch.oid ${head}`, '# branch.head feature/git', '# branch.upstream origin/feature/git', '# branch.ab +2 -1',
    '1 .M N... 100644 100644 100644 ' + sha('c') + ' ' + sha('d') + ' src/example.ts',
    '2 R. N... 100644 100644 100644 ' + sha('e') + ' ' + sha('f') + ' R100 src/new.ts',
    'src/old.ts',
    'u UU N... 100644 100644 100644 100644 ' + sha('1') + ' ' + sha('2') + ' ' + sha('3') + ' src/conflict.ts',
    '? notes/scratch.md',
  ].join('\0') + '\0'
  const parsed = parsePorcelainV2(output)
  assert.deepEqual(parsed.branch, { headSha: head, branch: 'feature/git', detached: false,
    upstream: { remote: 'origin', branch: 'feature/git', ahead: 2, behind: 1 } })
  assert.deepEqual(parsed.entries, [
    { path: 'notes/scratch.md', previousPath: null, index: null, worktree: null, conflicted: false, untracked: true },
    { path: 'src/conflict.ts', previousPath: null, index: 'conflicted', worktree: 'conflicted', conflicted: true, untracked: false },
    { path: 'src/example.ts', previousPath: null, index: null, worktree: 'modified', conflicted: false, untracked: false },
    { path: 'src/new.ts', previousPath: 'src/old.ts', index: 'renamed', worktree: null, conflicted: false, untracked: false },
  ])
})

test('porcelain v2 detached heads and missing upstream stay explicit', () => {
  const parsed = parsePorcelainV2([`# branch.oid ${head}`, '# branch.head (detached)'].join('\0') + '\0')
  assert.equal(parsed.branch.detached, true)
  assert.equal(parsed.branch.branch, null)
  assert.equal(parsed.branch.upstream, null)
  assert.throws(() => parsePorcelainV2('1 nope\0'))
})

test('porcelain v2 names the record it cannot read and skips ignored paths', () => {
  // An ignored path is never tracked, so it cannot join a restore plan.
  assert.deepEqual(parsePorcelainV2('! build/\0? notes.md\0').entries.map(entry => entry.path), ['notes.md'])
  // The message carries the record itself: `status_parse` alone cannot be
  // traced back to whichever repository printed it.
  assert.throws(() => parsePorcelainV2('x unreadable\0'), /status_parse: "x unreadable"/)
})

test('git log parsing normalizes offsets and marks HEAD/base without inventing authorship', () => {
  const first = sha('1'), second = sha('2')
  const output = [
    first, second, 'Ada', 'ada@example.invalid', '2026-11-10T10:00:00+02:00', '2026-11-10T10:01:00+02:00', 'Latest change',
    second, '', 'Grace', 'grace@example.invalid', '2026-11-09T08:00:00Z', '2026-11-09T08:00:00Z', 'Base change',
    '',
  ].join('\0')
  const commits = parseGitLog(output, { headSha: first, baseSha: second })
  assert.equal(commits.length, 2)
  assert.deepEqual(commits[0], { sha: first, parents: [second], authorName: 'Ada', authorEmail: 'ada@example.invalid',
    authoredAt: '2026-11-10T08:00:00.000Z', committedAt: '2026-11-10T08:01:00.000Z', subject: 'Latest change', head: true, base: false })
  assert.deepEqual(commits[1], { sha: second, parents: [], authorName: 'Grace', authorEmail: 'grace@example.invalid',
    authoredAt: '2026-11-09T08:00:00.000Z', committedAt: '2026-11-09T08:00:00.000Z', subject: 'Base change', head: false, base: true })
  assert.match(gitLogFormat, /%H%x00%P/)
  // Git writes a newline before every record after the first unless `-z` asks
  // for NUL separators, and the format must leave the separator to `-z`.
  assert.ok(gitLogArgs(5, 0).includes('-z'))
  assert.equal(gitLogFormat.endsWith('%s'), true)
})

test('history cursors are bound to the observed HEAD and bounded', () => {
  assert.equal(parseHistoryCursor(undefined, head), 0)
  assert.equal(parseHistoryCursor(historyCursor(head, 30), head), 30)
  assert.equal(parseHistoryCursor(historyCursor(base, 30), head), null)
  assert.equal(parseHistoryCursor(`${head}:999999999`, head), null)
  assert.equal(parseHistoryCursor('garbage', head), null)
})
