// Read-only, bounded observation for a failed real lifecycle draft assertion.
// Text, storage keys, account/workspace IDs and request URLs never leave the page.
export function installComposerDiagnostics() {
  if (window.__mikkaComposerDiagnostics) return
  const events = [], nodes = new WeakMap(), cells = new Map()
  let nextNode = 0, dropped = 0, previousNode = null
  const identity = node => {
    if (!node) return null
    if (!nodes.has(node)) nodes.set(node, ++nextNode)
    return nodes.get(node)
  }
  const snapshot = node => {
    const current = document.querySelector('textarea[data-chat-composer]')
    const drafts = []
    let storageReadable = true
    try {
      for (let index = 0; index < Math.min(sessionStorage.length, 128) && drafts.length < 8; index++) {
        const key = sessionStorage.key(index)
        if (!key?.startsWith('mikka:view:v1:') || !key.endsWith(':draft')) continue
        if (!cells.has(key) && cells.size < 32) cells.set(key, cells.size + 1)
        const value = JSON.parse(sessionStorage.getItem(key))
        drafts.push({ cell: cells.get(key) ?? null, length: typeof value === 'string' ? value.length : null })
      }
    } catch { storageReadable = false }
    return {
      currentNode: identity(current), eventNode: identity(node), connected: node ? node.isConnected : null,
      length: current?.value.length ?? null, eventLength: node?.value.length ?? null,
      disabled: current?.disabled ?? null, readOnly: current?.readOnly ?? null,
      composers: document.querySelectorAll('textarea[data-chat-composer]').length,
      storageReadable, drafts,
    }
  }
  const record = (kind, node) => {
    if (events.length === 32) { events.shift(); dropped++ }
    events.push({ kind, at: Math.round(performance.now()), ...snapshot(node) })
  }
  document.addEventListener('input', event => {
    const node = event.target
    if (!(node instanceof HTMLTextAreaElement) || !node.matches('textarea[data-chat-composer]')) return
    record('input', node)
    queueMicrotask(() => record('after-input', node))
  }, true)
  window.addEventListener('mikka:clear-view-state', () => record('clear-view-state'))
  const observer = new MutationObserver(() => {
    const current = document.querySelector('textarea[data-chat-composer]')
    if (current !== previousNode) { previousNode = current; record('composer-changed') }
  })
  observer.observe(document, { childList: true, subtree: true })
  window.__mikkaComposerDiagnostics = { read: () => ({ state: 'observed', dropped, current: snapshot(), events: [...events] }) }
  previousNode = document.querySelector('textarea[data-chat-composer]')
  record('installed')
}

export async function observeComposerDiagnostics(page) {
  await page.addInitScript(installComposerDiagnostics).catch(() => {})
  // firstWindow can precede the initial document commit; addInitScript covers it.
  await page.evaluate(installComposerDiagnostics).catch(() => {})
}

export async function readComposerDiagnostics(page) {
  try {
    return await page.evaluate(() => window.__mikkaComposerDiagnostics?.read() ?? { state: 'not-installed' })
  } catch { return { state: 'unavailable' } }
}
