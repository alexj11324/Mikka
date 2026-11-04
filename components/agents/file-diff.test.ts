import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSingularPatch } from '@pierre/diffs'
import { linesToPatch, newSideText, type FileDiffLine } from './file-diff'

const reply: FileDiffLine[] = [
  { type: 'context', content: 'export function title() {' },
  { type: 'removed', content: "  return '旧标题'" },
  { type: 'added', content: "  return '周报'" },
  { type: 'context', content: '}' },
]

test('every streamed prefix of a reply is a whole patch the renderer reads', () => {
  // While a reply streams, each new line (and a half-written last one) still parses, with matching counts.
  for (let end = 0; end <= reply.length; end++) {
    const lines = reply.slice(0, end)
    const last = lines.at(-1)
    const partial = last ? [...lines.slice(0, -1), { ...last, content: last.content.slice(0, 5) }] : lines
    for (const shown of [lines, partial]) {
      const diff = getSingularPatch(linesToPatch('lib/report.ts', shown))
      assert.equal(diff.name, 'lib/report.ts')
      assert.equal(diff.type, 'change')
      const hunk = diff.hunks[0]
      assert.equal(hunk?.additionCount ?? 0, shown.filter(line => line.type !== 'removed').length)
      assert.equal(hunk?.deletionCount ?? 0, shown.filter(line => line.type !== 'added').length)
    }
  }
})

test('a streamed reply only grows: earlier lines keep their place as lines arrive', () => {
  const rows = (lines: FileDiffLine[]) => linesToPatch('a.ts', lines).split('\n').slice(4, 4 + lines.length)
  for (let end = 1; end < reply.length; end++) assert.deepEqual(rows(reply.slice(0, end + 1)).slice(0, end), rows(reply.slice(0, end)))
})

test('a change of thousands of lines keeps every line', () => {
  const lines = Array.from({ length: 3000 }, (_, index): FileDiffLine => ({ type: index % 2 ? 'added' : 'removed', content: `line ${index}` }))
  const diff = getSingularPatch(linesToPatch('big.ts', lines))
  assert.equal(diff.unifiedLineCount, 3000)
  assert.deepEqual([diff.hunks[0].additionLines, diff.hunks[0].deletionLines], [1500, 1500])
})

test('copy takes the code after the change', () => {
  assert.equal(newSideText(reply), "export function title() {\n  return '周报'\n}")
})
