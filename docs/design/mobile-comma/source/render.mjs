// Renders every frame in screens.html to ../light/<id>.png and ../dark/<id>.png at 2x,
// plus ../overview-light.png and ../overview-dark.png.
// Usage: FONT_DIR=/path/to/noto-sans-sc-woff2 node docs/design/mobile-comma/source/render.mjs
// FONT_DIR holds the four @fontsource/noto-sans-sc "chinese-simplified" woff2 files (400/500/600/700);
// without it the page falls back to the machine's CJK font.
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Playwright resolves like require(), so NODE_PATH reaches a global install.
const { chromium } = createRequire(import.meta.url)('playwright')
const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, '..')
const stage = mkdtempSync(join(tmpdir(), 'mikka-frames-'))
cpSync(join(here, 'screens.html'), join(stage, 'source', 'screens.html'), { recursive: true })
if (process.env.FONT_DIR) symlinkSync(process.env.FONT_DIR, join(stage, 'source', 'fonts'))
const page = `file://${join(stage, 'source', 'screens.html')}`

const browser = await chromium.launch()
try {
  for (const theme of ['light', 'dark']) {
    mkdirSync(join(out, theme), { recursive: true })
    mkdirSync(join(stage, theme), { recursive: true })
    const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, colorScheme: theme })
    const tab = await context.newPage()
    await tab.goto(`${page}${theme === 'dark' ? '?dark' : ''}`)
    const ids = await tab.evaluate(() => window.SCREENS)
    for (const id of ids) {
      await tab.goto(`${page}${theme === 'dark' ? '?dark' : ''}#${id}`)
      await tab.reload()
      await tab.evaluate(() => document.fonts.ready)
      await tab.screenshot({ path: join(out, theme, `${id}.png`) })
      cpSync(join(out, theme, `${id}.png`), join(stage, theme, `${id}.png`))
    }
    await context.close()
    const overview = await browser.newContext({ viewport: { width: 2040, height: 800 }, deviceScaleFactor: 1, colorScheme: theme })
    const o = await overview.newPage()
    await o.goto(`${page}?overview${theme === 'dark' ? '&dark' : ''}`)
    await o.waitForLoadState('load')
    await o.screenshot({ path: join(out, `overview-${theme}.png`), fullPage: true })
    await overview.close()
  }
} finally {
  await browser.close()
}
