import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { before, mock, test } from 'node:test'
import { createContext, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseUnifiedDiff } from '@/lib/thread-changes'

// The real Chinese copy, so the test reads what the person sees.
const zh = JSON.parse(readFileSync(new URL('../../messages/zh-CN.json', import.meta.url), 'utf8')) as Record<string, Record<string, string>>
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => (key: string, values: Record<string, unknown> = {}) =>
  zh[namespace][key].replace(/\{(\w+)\}/g, (_, name: string) => String(values[name])) } })
// @pierre/diffs draws inside a shadow root on the client; record what each file hands it.
type Drawn = { fileDiff: import('@pierre/diffs').FileDiffMetadata; options: Record<string, unknown> }
let drawn: Drawn[] = []
mock.module('@pierre/diffs/react', { namedExports: { FileDiff: (props: Drawn & { renderHeaderPrefix?: () => ReactNode; renderHeaderMetadata?: () => ReactNode }) => {
  drawn.push({ fileDiff: props.fileDiff, options: props.options })
  return <div data-diffs-stub=""><div slot="header-prefix">{props.renderHeaderPrefix?.()}</div>{props.renderHeaderMetadata && <div slot="header-metadata">{props.renderHeaderMetadata()}</div>}</div>
}, VirtualizerContext: createContext(undefined) } })
mock.module('next-themes', { namedExports: { useTheme: () => ({ resolvedTheme: 'dark' }) } })
let ThreadChangesView: typeof import('./thread-changes')['ThreadChangesView']
let DIFF_SURFACE_CSS: string
before(async () => { ({ ThreadChangesView, DIFF_SURFACE_CSS } = await import('./thread-changes')) })

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
  drawn = []
  return renderToStaticMarkup(<ThreadChangesView changes={changes} wrap="wrap" onWrapChange={() => {}} filesOpen={false} onFilesOpenChange={() => {}} {...props} />)
}

test('long lines wrap by default; 横向滚动 hands the renderer a scrolling layout', () => {
  const html = render()
  assert.match(html, /data-wrap="wrap"/)
  assert.deepEqual(drawn.map(file => file.options.overflow), ['wrap', 'wrap'])
  render({ wrap: 'scroll' })
  assert.deepEqual(drawn.map(file => file.options.overflow), ['scroll', 'scroll'])
  // The long-line control shows which one is on.
  const scrolling = render({ wrap: 'scroll' })
  assert.match(scrolling, /data-wrap="scroll"/)
  assert.match(scrolling, /aria-label="长行"/)
  assert.match(scrolling, />换行</)
  assert.match(scrolling, />横向滚动</)
})

test('each file is drawn by the library with its own look: stacked lines, the theme Mikka is in, a sticky header', () => {
  render()
  for (const { options } of drawn) {
    assert.equal(options.diffStyle, 'unified')
    assert.equal(options.themeType, 'dark')
    assert.equal(options.stickyHeader, true)
    // Pierre's WebAssembly highlighter: the default Shiki engine takes ~4 s on a 3,000-line change.
    assert.equal(options.preferredHighlighter, 'highlights')
    assert.equal(options.collapsed, false)
    // Pierre's default themes: nothing of Mikka's old diff styling is passed in, only the card's surface (task-06).
    assert.equal(options.theme, undefined)
    assert.equal(options.unsafeCSS, DIFF_SURFACE_CSS)
  }
  assert.deepEqual(drawn.map(file => [file.fileDiff.name, file.fileDiff.type]), [['app/pricing/table.tsx', 'change'], ['lib/pricing/competitors.ts', 'new']])
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

test('lines the diff left out stay out, with each hunk at its own line numbers; files follow in order', () => {
  const html = render()
  const [table, created] = drawn.map(file => file.fileDiff.hunks)
  // 18 lines before line 19, then old lines 21–39 between the hunks.
  assert.deepEqual(table.map(hunk => [hunk.collapsedBefore, hunk.deletionStart, hunk.deletionCount, hunk.additionStart, hunk.additionCount]), [[18, 19, 2, 19, 2], [19, 40, 1, 40, 1]])
  assert.deepEqual(created.map(hunk => [hunk.collapsedBefore, hunk.additionStart, hunk.additionCount]), [[0, 1, 1]])
  const order = [...html.matchAll(/<section aria-label="([^"]+)"/g)].map(match => match[1])
  assert.deepEqual(order, ['app/pricing/table.tsx', 'lib/pricing/competitors.ts'])
})

test('each file header carries its fold control in the library header', () => {
  const html = render()
  assert.deepEqual([...html.matchAll(/<div slot="header-prefix"><button[^>]*aria-expanded="true"[^>]*aria-label="([^"]+)"/g)].map(match => match[1]), ['收起 table.tsx', '收起 competitors.ts'])
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
