import assert from 'node:assert/strict'
import { test } from 'node:test'
import { getSingularPatch } from '@pierre/diffs'
import { diffWrapFrom, filePatch, parseUnifiedDiff, splitPath } from './thread-changes'

const DIFF = `diff --git a/app/pricing/components/pricing-table.tsx b/app/pricing/components/pricing-table.tsx
index 1111111..2222222 100644
--- a/app/pricing/components/pricing-table.tsx
+++ b/app/pricing/components/pricing-table.tsx
@@ -19,3 +19,4 @@ export function PricingTable() {
 export function PricingTable({ plans }: Props) {
-  const rows = plans.map(toRow);
+  const competitors = useCompetitorPrices(plans);
+  const rows = plans.map((p) => toRow(p, competitors));

@@ -58,2 +59,2 @@
-    <PriceHeader />
+    <PriceHeader showCompetitors />
 </Table>
diff --git a/lib/pricing/competitors.ts b/lib/pricing/competitors.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/lib/pricing/competitors.ts
@@ -0,0 +1,2 @@
+import { z } from "zod";
+export const Price = z.object({});
\\ No newline at end of file
diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
diff --git a/public/logo.png b/public/logo.png
index 4444444..5555555 100644
Binary files a/public/logo.png and b/public/logo.png differ
`

test('files come in the diff\'s order with their own and the total +x −y', () => {
  const changes = parseUnifiedDiff(DIFF)
  assert.deepEqual(changes.files.map(file => file.path), ['app/pricing/components/pricing-table.tsx', 'lib/pricing/competitors.ts', 'new-name.ts', 'public/logo.png'])
  assert.deepEqual(changes.files.map(file => [file.additions, file.deletions]), [[3, 2], [2, 0], [0, 0], [0, 0]])
  assert.equal(changes.additions, 5)
  assert.equal(changes.deletions, 2)
  assert.equal(changes.files[1].status, 'added')
  assert.deepEqual([changes.files[2].status, changes.files[2].previousPath], ['renamed', 'old-name.ts'])
  assert.equal(changes.files[3].binary, true)
})

test('lines the diff left out fold into 「N 行未修改」 runs before and between hunks', () => {
  const [table, created] = parseUnifiedDiff(DIFF).files
  const folds = table.blocks.flatMap(block => block.kind === 'unchanged' ? [block.count] : [])
  // 18 lines before line 19; then old lines 22–57 between the hunks.
  assert.deepEqual(folds, [18, 36])
  assert.equal(table.blocks[0].kind, 'unchanged')
  // A new file has nothing unchanged.
  assert.equal(created.blocks.some(block => block.kind === 'unchanged'), false)
})

test('each line keeps its old and new numbers; an added line has no old number', () => {
  const [table] = parseUnifiedDiff(DIFF).files
  const lines = table.blocks.flatMap(block => block.kind === 'line' ? [block.line] : [])
  assert.deepEqual(lines.slice(0, 5).map(line => [line.kind, line.old, line.new]), [
    ['context', 19, 19], ['removed', 20, null], ['added', null, 20], ['added', null, 21], ['context', 21, 22],
  ])
  assert.deepEqual(lines.slice(5).map(line => [line.kind, line.old, line.new]), [['removed', 58, null], ['added', null, 59], ['context', 59, 60]])
  assert.equal(lines[1].text, '  const rows = plans.map(toRow);')
})

test('a file name splits from its folder', () => {
  assert.deepEqual(splitPath('app/pricing/hooks/use-prices.ts'), { name: 'use-prices.ts', dir: 'app/pricing/hooks/' })
  assert.deepEqual(splitPath('README.md'), { name: 'README.md', dir: '' })
})

test('long lines wrap unless horizontal scrolling was chosen', () => {
  assert.equal(diffWrapFrom(null), 'wrap')
  assert.equal(diffWrapFrom('anything'), 'wrap')
  assert.equal(diffWrapFrom('wrap'), 'wrap')
  assert.equal(diffWrapFrom('scroll'), 'scroll')
})

test('each file goes back to the renderer as its own patch, hunks at their own line numbers', () => {
  const [table, created, renamed, binary] = parseUnifiedDiff(DIFF).files.map(file => getSingularPatch(filePatch(file)))
  assert.deepEqual(table.hunks.map(hunk => [hunk.collapsedBefore, hunk.deletionStart, hunk.deletionCount, hunk.additionStart, hunk.additionCount, hunk.additionLines, hunk.deletionLines]),
    [[18, 19, 3, 19, 4, 2, 1], [36, 58, 2, 59, 2, 1, 1]])
  assert.deepEqual([created.type, created.hunks[0].additionStart, created.hunks[0].additionCount], ['new', 1, 2])
  assert.deepEqual([renamed.type, renamed.prevName, renamed.name], ['rename-pure', 'old-name.ts', 'new-name.ts'])
  assert.deepEqual([binary.name, binary.hunks.length], ['public/logo.png', 0])
})

test('a hunk that only adds or only removes starts where git puts its empty side', () => {
  const text = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -3,1 +3,2 @@
-x
+y
+z
@@ -10,0 +12,2 @@
+p
+q
@@ -20,2 +22,0 @@
-r
-s
`
  const [file] = parseUnifiedDiff(text).files
  assert.equal(filePatch(file).split('\n').filter(line => line.startsWith('@@')).join('|'), '@@ -3,1 +3,2 @@|@@ -10,0 +12,2 @@|@@ -20,2 +22,0 @@')
})

test('a change of thousands of lines round-trips whole', () => {
  const lines = Array.from({ length: 3000 }, (_, index) => index % 3 === 0 ? `-old ${index}` : index % 3 === 1 ? `+new ${index}` : ` same ${index}`)
  const [file] = parseUnifiedDiff(`diff --git a/big.ts b/big.ts\n--- a/big.ts\n+++ b/big.ts\n@@ -1,2000 +1,2000 @@\n${lines.join('\n')}\n`).files
  const drawn = getSingularPatch(filePatch(file))
  assert.equal(drawn.hunks.length, 1)
  assert.deepEqual([drawn.hunks[0].additionLines, drawn.hunks[0].deletionLines, drawn.hunks[0].additionCount, drawn.hunks[0].deletionCount], [1000, 1000, 2000, 2000])
  assert.equal(drawn.unifiedLineCount, 3000)
})
