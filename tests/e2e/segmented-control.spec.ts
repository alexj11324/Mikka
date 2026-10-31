import type { Page } from '@playwright/test'
import { test, expect, register } from './fixtures'

// R-37 and decisions.md 2026-10-31 (segmented control motion): the selected mark of a segmented
// control is one rounded pill per group that glides to the clicked item on a spring, and lands
// at once when the OS asks for reduced motion. Checked on 偏好设置 › 界面主题.

type Frames = { lefts: number[], from: number, to: number, width: number, targetWidth: number, radius: string }

// Clicks the item and records the pill's left edge on every frame for 700ms.
function clickAndTrack(page: Page, label: string) {
  return page.evaluate(async (label): Promise<Frames> => {
    const group = document.querySelector('main [role="group"][aria-label="界面主题"]')!
    const pill = () => group.querySelector<HTMLElement>('[data-slot="segment-indicator"]')!
    const target = group.querySelector<HTMLElement>(`button[aria-label="${label}"]`)!
    const from = pill().getBoundingClientRect().left
    target.click()
    const lefts: number[] = []
    const start = performance.now()
    while (performance.now() - start < 700) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      lefts.push(pill().getBoundingClientRect().left)
    }
    const box = pill().getBoundingClientRect(), goal = target.getBoundingClientRect()
    return { lefts, from, to: goal.left, width: box.width, targetWidth: goal.width, radius: getComputedStyle(pill()).borderTopLeftRadius }
  }, label)
}

test('the theme control’s pill glides to the clicked option, and lands at once with reduced motion', async ({ page }) => {
  await register(page, '/settings?section=preferences')
  const group = page.getByRole('group', { name: '界面主题', exact: true })
  const light = group.getByRole('button', { name: '浅色', exact: true })
  await light.click()
  await expect(light).toHaveAttribute('aria-pressed', 'true')
  await expect(group.locator('[data-slot="segment-indicator"]')).toHaveCount(1)
  await page.waitForTimeout(700)

  const glide = await clickAndTrack(page, '深色')
  await expect(group.getByRole('button', { name: '深色', exact: true })).toHaveAttribute('aria-pressed', 'true')
  // Moving: some frames sit strictly between the old and the new item.
  const between = glide.lefts.filter(left => left > Math.min(glide.from, glide.to) + 2 && left < Math.max(glide.from, glide.to) - 2)
  expect(between.length).toBeGreaterThan(2)
  // Settled: on the new item, its own width, rounded on every side, with no overshoot past it.
  expect(Math.abs(glide.lefts.at(-1)! - glide.to)).toBeLessThan(1)
  expect(Math.abs(glide.width - glide.targetWidth)).toBeLessThan(1)
  expect(glide.radius).toBe('6px')
  expect(Math.max(...glide.lefts)).toBeLessThan(glide.to + 1.5)
  await expect(group.locator('[data-slot="segment-indicator"]')).toHaveCount(1)

  // Motion reads the OS setting when the page loads.
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.reload()
  await expect(group.getByRole('button', { name: '深色', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const reduced = await clickAndTrack(page, '浅色')
  await expect(light).toHaveAttribute('aria-pressed', 'true')
  // No frame in between: the pill is on 浅色 from the first frame React has committed the click.
  expect(reduced.lefts.slice(1).every(left => Math.abs(left - reduced.to) < 1)).toBe(true)
  expect(reduced.lefts.some(left => left > reduced.to + 2 && left < reduced.from - 2)).toBe(false)
})
