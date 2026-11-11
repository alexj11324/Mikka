import type { Page } from '@playwright/test'
import { test, expect, register, seedTask, app } from './fixtures'

/**
 * The issue detail page's visual baseline (ALE-17; ALE-16's "done when": layout verified at 100% zoom in light and
 * dark, at phone, tablet and desktop width).
 *
 * This is the repository's first pixel comparison — `grep toHaveScreenshot tests/` had zero hits before it — so it also
 * fixes the convention the next one follows.
 *
 * How it is used:
 *  1. On the commit *before* a layout change, run `pnpm test:visual:update` with E2E_DATABASE_URL set. That writes the
 *     baselines under `tests/e2e/visual-issue-detail.spec.ts-snapshots/`. Commit them on their own.
 *  2. Apply the change and run `pnpm test:visual`. A passing run means the pixels are identical.
 *
 * Rules the baselines follow:
 *  - What is captured is the three surfaces ALE-17 changes: the header, the title field and the properties column. The
 *    whole page is deliberately not captured: its description editor and activity feed carry relative timestamps
 *    ("2 分钟前") that change with the clock, so a full-page baseline could not hold `maxDiffPixels: 0` honestly.
 *  - The seed is fixed (constant title, no random ids), so the only variable is the code.
 *  - `maxDiffPixels: 0`: a layout change is meant to be visible, so any tolerance would hide what this measures.
 *  - Fonts are whatever the runner has. These run on the CI image, never on a developer's Mac (AGENTS.md); a baseline
 *    regenerated on another platform is a different baseline, not a fix for a diff.
 *  - A diff is never closed by editing this file, its sizes or its selectors, or by loosening `maxDiffPixels`. Fix the
 *    layout, or re-baseline deliberately at step 1 and say why in the PR.
 */

// 390 phone / 768 tablet / 1440 desktop, each in light and dark: the six states the issue names.
const SIZES = [
  { name: 'phone', width: 390, height: 844, desktop: false },
  { name: 'tablet', width: 768, height: 1024, desktop: false },
  { name: 'desktop', width: 1440, height: 900, desktop: true },
] as const

const SCHEMES = ['light', 'dark'] as const

/** A constant title, not randomUUID(): a baseline has to be the same page on every run. */
const TITLE = '结算失败后重试没有刷新状态'

async function openTaskPage(page: Page) {
  await register(page)
  const issueId = await seedTask(page, TITLE)
  await page.goto(app(`/?section=all-issues&issue=${issueId}`))
  await expect(page.getByLabel('任务标题', { exact: true })).toHaveValue(TITLE)
  return { issueId }
}

/**
 * Dark mode is next-themes' `attribute="class"`, so `colorScheme` reaches it — but only after `.dark` is actually on
 * <html>. Asserting that first keeps a "dark" baseline from silently being the light page.
 */
async function applyScheme(page: Page, scheme: (typeof SCHEMES)[number]) {
  await page.emulateMedia({ colorScheme: scheme })
  if (scheme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/)
  else await expect(page.locator('html')).not.toHaveClass(/dark/)
}

/**
 * Below lg the properties column is a disclosure and starts closed. Opening it is the state ALE-17's first item is
 * about (relations collapsing with the properties), so the baseline captures it open there and untouched on desktop.
 */
async function expandPropertiesOnNarrow(page: Page, desktop: boolean) {
  if (desktop) return
  const disclosure = page.getByRole('button', { name: '属性与任务关系', exact: true })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
}

/** The screenshot options every shot shares. */
const SHOT = { maxDiffPixels: 0, animations: 'disabled', scale: 'css' } as const

for (const size of SIZES) {
  for (const scheme of SCHEMES) {
    test(`issue detail baseline: ${size.name} ${scheme}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height })
      await openTaskPage(page)
      await applyScheme(page, scheme)
      await expandPropertiesOnNarrow(page, size.desktop)
      // A settled frame: entry animation finishes even with animations disabled, and fonts must be loaded.
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(300)

      // Scoped to the task page's own region so an app-shell header can never be captured instead.
      const taskPage = page.getByRole('region').first()
      await expect(taskPage.locator('header')).toHaveScreenshot(`header-${size.name}-${scheme}.png`, SHOT)
      await expect(page.locator('#task-title')).toHaveScreenshot(`title-${size.name}-${scheme}.png`, SHOT)
      await expect(page.locator('#issue-properties')).toHaveScreenshot(`properties-${size.name}-${scheme}.png`, SHOT)
    })
  }
}

/**
 * ALE-17 item 1, stated as behaviour rather than pixels: on a phone the one disclosure opens properties *and*
 * relations, so the column collapses as one unit and the label matches what it holds.
 */
test('phone disclosure holds both properties and relations', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await openTaskPage(page)
  const disclosure = page.getByRole('button', { name: '属性与任务关系', exact: true })
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  const content = page.locator(`#${(await disclosure.getAttribute('aria-controls'))!}`)
  // Closed: the whole group, relations included, is out of the way.
  await expect(content).toBeHidden()

  await disclosure.click()
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  await expect(content).toBeVisible()
  // Relations render inside the region the button controls, not as a sibling after it.
  await expect(content.locator('[data-slot="issue-relations"]')).toBeAttached()
})
