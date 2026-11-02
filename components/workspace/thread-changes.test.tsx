import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, mock, test } from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseUnifiedDiff } from '@/lib/thread-changes'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string, values: Record<string, unknown> = {}) =>
  zh[namespace][key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name])) } })
let ThreadChangesView: typeof import('./thread-changes')['ThreadChangesView']
before(async () => { ({ ThreadChangesView } = await import('./thread-changes')) })

const LONG = 'export const PriceSchema = z.object({ vendor: z.string(), plan: z.string(), monthly: z.number() });'
const changes = parseUnifiedDiff(`diff --git a/app/pricing/table.tsx b/app/pricing/table.tsx
--- a/app/pricing/table.tsx
+++ b/app/pricing/table.tsx
@@ -19,2 +19,2 @@
 export function PricingTable() {
-  const rows = plans.map(toRow);
+${LONG}
@@ -40,1 +40,1 @@
-  return null
+  return rows
diff --git a/lib/pricing/competitors.ts b/lib/pricing/competitors.ts
new file mode 100644
--- /dev/null
+++ b/lib/pricing/competitors.ts
@@ -0,0 +1 @@
+import { z } from "zod";
`)

function render(props: Partial<Parameters<typeof ThreadChangesView>[0]> = {}) {
  return renderToStaticMarkup(<ThreadChangesView changes={changes} wrap="wrap" onWrapChange={() => {}} filesOpen={false} onFilesOpenChange={() => {}} {...props} />)
}

test('long lines wrap by default: the code wraps, no horizontal scroller', () => {
  const html = render()
  assert.match(html, /data-wrap="wrap"/)
  assert.match(html, /whitespace-pre-wrap/)
  assert.doesNotMatch(html, /thread-changes-hscroll/)
  // Each line has one row; a wrapped line's continuation has no number of its own.
  assert.equal(html.match(/data-slot="thread-changes-line"/g)?.length, 6)
})

test('横向滚动 keeps each line on one row and scrolls the code, numbers staying put', () => {
  const html = render({ wrap: 'scroll' })
  assert.match(html, /data-wrap="scroll"/)
  assert.match(html, /data-slot="thread-changes-hscroll"/)
  assert.match(html, /sticky left-0/)
  assert.doesNotMatch(html, /whitespace-pre-wrap/)
  // The long-line control shows which one is on.
  assert.match(html, /aria-label="长行"/)
  assert.match(html, />换行</)
  assert.match(html, />横向滚动</)
})

test('the file list is folded into 「N 个文件 +x −y」 until opened', () => {
  const closed = render()
  assert.match(closed, /2 个文件/)
  assert.match(closed, /\+3<\/span>/)
  assert.match(closed, /−2<\/span>/)
  assert.match(closed, /aria-expanded="false"/)
  assert.doesNotMatch(closed, /thread-changes-files/)
  const open = render({ filesOpen: true })
  assert.match(open, /aria-expanded="true"/)
  assert.match(open, /data-slot="thread-changes-files"/)
  assert.match(open, /aria-label="文件列表"/)
})

test('lines the diff left out read 「N 行未修改」; files follow in order with sticky headers', () => {
  const html = render()
  assert.deepEqual([...html.matchAll(/data-slot="thread-changes-unchanged"[^>]*>([^<]+)</g)].map(match => match[1]), ['18 行未修改', '19 行未修改'])
  assert.doesNotMatch(html, /未显示/)
  const order = [...html.matchAll(/<section aria-label="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(order, ['app/pricing/table.tsx', 'lib/pricing/competitors.ts'])
  assert.equal(html.match(/sticky -top-3/g)?.length, 2)
})

test('read-only: nothing to edit, comment on, run or mark as viewed', () => {
  const html = render({ filesOpen: true })
  assert.doesNotMatch(html, /<(?:textarea|input)\b/)
  assert.doesNotMatch(html, /contenteditable|已查看|终端|评论/)
  // Without a pull request there is no file to open on GitHub.
  assert.doesNotMatch(html, /在新标签打开/)
  const linked = renderToStaticMarkup(<ThreadChangesView changes={{ ...changes, files: changes.files.map(file => ({ ...file, url: `https://github.com/acme/app/pull/7/files#diff-${file.path.length}` })) }} wrap="wrap" onWrapChange={() => {}} filesOpen={false} onFilesOpenChange={() => {}} />)
  assert.match(linked, /aria-label="在新标签打开"/)
  assert.match(linked, /target="_blank"/)
})
