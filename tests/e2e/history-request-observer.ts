import type { Page } from '@playwright/test'

/** Observe every matching read from main-frame documents navigated after setup. */
export async function observeNewDocumentHistory(page: Page, pathname: string) {
  const historyRequests: string[] = []
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Network.enable')
  const { frameTree } = await cdp.send('Page.getFrameTree')
  const documents = new Set<string>()
  cdp.on('Network.requestWillBeSent', event => {
    if (event.frameId !== frameTree.frame.id) return
    if (event.type === 'Document' && event.loaderId !== frameTree.frame.loaderId) documents.add(event.loaderId)
    // register() can leave a fixture-document fetch starting during reload.
    // Keep every request from measured documents, including duplicates and
    // failures; response status and completion never filter this counter.
    if (documents.has(event.loaderId) && new URL(event.request.url).pathname === pathname) {
      historyRequests.push(event.request.url)
    }
  })
  return { historyRequests, cdp }
}
