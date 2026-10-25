import { test, expect, register, app } from './fixtures'
import { observeNewDocumentHistory } from './history-request-observer'

test('history observer excludes the fixture document and catches a real duplicate in the measured document', async ({ page }, info) => {
  await register(page)
  const path = app('/api/agent/sessions')
  const { historyRequests, cdp } = await observeNewDocumentHistory(page, path)
  const read = async () => page.evaluate(async url => {
    const response = await fetch(url, { cache: 'no-store', credentials: 'same-origin' })
    if (!response.ok) throw new Error(`History read failed: HTTP ${response.status}`)
    await response.json()
  }, path)
  try {
    // Actual HTTP from the old fixture document must stay outside the window.
    await read()
    expect(historyRequests).toHaveLength(0)
    await page.reload()
    await expect.poll(() => historyRequests.length).toBe(1)

    // Deliberately make a second real read in the same measured document.
    // The observer must retain it and the unchanged one-request gate reject it.
    await read()
    await expect.poll(() => historyRequests.length).toBe(2)
    expect(() => expect(historyRequests).toHaveLength(1)).toThrow()
    await info.attach('history-counter-negative-control', {
      body: JSON.stringify({ excludedFixtureReads: 1, initialMeasuredReads: 1, afterInducedDuplicate: 2, oneReadGateRejectedDuplicate: true }),
      contentType: 'application/json',
    })
  } finally {
    await cdp.detach()
  }
})
