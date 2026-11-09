/** Select once: main may reload before the IPC/evaluate reply is delivered. */
export async function selectBundledServer(page, selection, expectedUrl, { timeout = 30_000 } = {}) {
  if (typeof expectedUrl !== 'string' || !expectedUrl || !Number.isFinite(timeout) || timeout <= 0) throw new Error('NATIVE_SERVER_CHOICE_OPTIONS_INVALID')
  let timer, navigated, finished = false
  const navigation = new Promise(resolve => { navigated = resolve })
  const onNavigation = frame => { if (frame === page.mainFrame()) navigated() }
  page.on('framenavigated', onNavigation)
  try {
    const target = navigation.then(async () => {
      if (finished) return
      const handle = await page.waitForFunction(url => window.mikka?.app.serverUrl === url, expectedUrl, { timeout })
      await handle?.dispose()
    })
    const dispatch = Promise.resolve().then(() =>
      page.evaluate(url => window.mikka.bundled.server.select(url), selection)
    ).catch(error => {
      // Only this known protocol loss can be corroborated by the new document.
      // Selection refusal, detached frames and closed pages are still failures.
      if (!/^(?:page\.evaluate: )?Execution context was destroyed, most likely because of a navigation\.?$/.test(error?.message ?? '')) throw error
    })
    await Promise.race([
      Promise.all([dispatch, target]),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('NATIVE_SERVER_CHOICE_TIMEOUT')), timeout) }),
    ])
  } finally {
    finished = true
    clearTimeout(timer)
    page.off('framenavigated', onNavigation)
  }
}
