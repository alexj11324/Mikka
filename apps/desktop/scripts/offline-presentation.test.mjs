import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'
import { build } from 'esbuild'
import postcss from 'postcss'
import { nativeOfflineView } from './build-renderer.mjs'

test('the bundled offline card restores standalone font rendering instead of inheriting application typography', async () => {
  const result = await build({
    stdin: { contents: 'import "mikka:native-offline"' }, bundle: true, write: false,
    outdir: 'offline-contract', plugins: [nativeOfflineView()], logLevel: 'silent',
  })
  const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css'))
  assert.ok(stylesheet)
  const declarations = new Map()
  postcss.parse(stylesheet.text).walkRules(rule => {
    if (rule.selector === '.desktop-offline') for (const node of rule.nodes) {
      if (node.type === 'decl') declarations.set(node.prop, node.value)
    }
  })
  // f36's real macOS screenshots differed only in these three text regions.
  // The application body uses antialiased smoothing and its html disables
  // synthesis/enables optimizeLegibility; the standalone fallback uses auto.
  // These inherited properties are not reset by its existing font shorthand.
  for (const property of ['-webkit-font-smoothing', 'font-synthesis', 'text-rendering']) {
    assert.equal(declarations.get(property), 'auto', `${property} must match the standalone fallback`)
  }
})

test('standalone and bundled offline surfaces use the same factual state copy without a display timer', async () => {
  const html = await readFile(new URL('../src/offline.html', import.meta.url), 'utf8')
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1]
  assert.ok(script)
  for (const locale of ['en', 'zh-CN']) {
    const { DesktopRenderer: messages } = JSON.parse(await readFile(new URL(`../../../messages/${locale}.json`, import.meta.url), 'utf8'))
    for (const reason of ['network', 'server']) {
      const window = new Window()
      try {
        window.document.body.innerHTML = html.match(/<body>([\s\S]*?)<script>/)[1]
        runInNewContext(script, {
          document: window.document, navigator: { language: locale }, URLSearchParams,
          location: { search: `?reason=${reason}&app=${encodeURIComponent('https://example.invalid/mikka')}` },
          setInterval() { assert.fail('Offline copy must not add a timer or background read') },
        })
        const document = window.document
        assert.equal(document.getElementById('title').textContent, messages[`${reason}Unavailable`])
        assert.equal(document.getElementById('status').textContent, messages.offlineHint)
        assert.equal(document.getElementById('retry').textContent, messages.retry)
        assert.equal(document.getElementById('icon-network').hasAttribute('hidden'), reason !== 'network')
        assert.equal(document.getElementById('icon-server').hasAttribute('hidden'), reason !== 'server')
        document.getElementById('retry').dispatchEvent(new window.Event('click'))
        assert.equal(document.getElementById('status').textContent, messages.reconnecting)
      } finally { await window.happyDOM.close() }
    }
  }
})
