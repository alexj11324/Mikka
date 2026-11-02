import assert from 'node:assert/strict'
import { test } from 'node:test'
import { diffWrapFrom, parseUnifiedDiff, splitPath } from './thread-changes'

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
