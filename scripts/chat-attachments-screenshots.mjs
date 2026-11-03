// Screenshot review only: production navigation with fixed API-created fixtures, no interaction tests.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { chromium } from '@playwright/test'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const fixture = JSON.parse(await readFile(root + '/.cache/attachments/visual-fixture.json', 'utf8'))
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_EXECUTABLE_PATH,
  args: ['--no-sandbox'],
})
try {
  await mkdir(root + '/.cache/attachments/screenshots', { recursive: true, mode: 0o700 })
  const metrics = []
  for (const [theme, width, height] of [
    ['light', 1440, 1000],
    ['dark', 1440, 1000],
    ['light', 390, 844],
    ['dark', 390, 844],
  ]) {
    const context = await browser.newContext({
      storageState: fixture.statePath,
      viewport: { width, height },
      colorScheme: theme,
      deviceScaleFactor: 1,
      hasTouch: width === 390,
      isMobile: width === 390,
    })
    await context.addInitScript(
      ({ fixture, theme }) => {
        localStorage.setItem('theme', theme)
        sessionStorage.setItem(`mikka:draft:${fixture.userId}:${fixture.botId}`, fixture.draft)
        sessionStorage.setItem(`mikka:draft:${fixture.userId}:coordinator`, fixture.draft)
      },
      { fixture, theme },
    )
    const page = await context.newPage()
    await page.goto('http://localhost:3100/mikka/zh-CN', { waitUntil: 'networkidle' })
    await page.locator('[data-slot="chat-file-card"]').first().waitFor({ timeout: 20000 })
    await page.evaluate(() => document.fonts.ready)
    const result = await page.evaluate(() => ({
      viewport: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      cards: [...document.querySelectorAll('[data-slot="chat-file-card"]')].map((card) => {
        const title = card.querySelector('[data-slot="attachment-title"]')
        const r = card.getBoundingClientRect()
        const text = title?.getBoundingClientRect()
        return {
          width: r.width,
          height: r.height,
          titleWidth: text?.width,
          titleHeight: text?.height,
          overflow:
            !!text &&
            (text.left < r.left || text.right > r.right || text.top < r.top || text.bottom > r.bottom),
        }
      }),
    }))
    metrics.push({ theme, width, ...result })
    await page.screenshot({
      path: root + `/.cache/attachments/screenshots/${theme}-${width}.png`,
      fullPage: true,
    })
    await context.close()
  }
  await writeFile(root + '/.cache/attachments/screenshots/layout.json', JSON.stringify(metrics, null, 2))
  console.log(
    JSON.stringify({
      screenshots: 4,
      overflowingCards: metrics.flatMap((entry) => entry.cards).filter((card) => card.overflow).length,
    }),
  )
} finally {
  await browser.close()
}
