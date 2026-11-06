import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { Window } from 'happy-dom'

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
