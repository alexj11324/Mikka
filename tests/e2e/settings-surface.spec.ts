import { expect, test } from '@playwright/test'

const sections = ['偏好设置', '个人资料', '工作区']

/**
 * A settings card groups rows; its divider lines must reach the card edges.
 *
 * This is a geometry check, not a class check: a container padding on the
 * section wrapper shortens every divider by that padding, which is invisible
 * to static lint. Measuring the rendered boxes is the only reliable signal.
 */
test('settings row dividers span the grouped card edges', async ({ page }) => {
  await page.goto('/preview/settings')

  for (const section of sections) {
    await page.getByRole('button', { name: section }).click()
    await expect(page.getByRole('heading', { level: 1, name: section })).toBeVisible()

    const mismatches = await page.evaluate(() => {
      const problems: Array<{ left: number; right: number; border: number }> = []
      for (const card of Array.from(document.querySelectorAll<HTMLElement>('[data-settings-card]'))) {
        const rows = card.matches('.divide-y')
          ? card
          : card.querySelector<HTMLElement>('[data-settings-rows], .divide-y')
        if (!rows) continue
        const cardBox = card.getBoundingClientRect()
        const rowsBox = rows.getBoundingClientRect()
        const border = Number.parseFloat(getComputedStyle(card).borderLeftWidth) || 0
        const left = Math.round(rowsBox.left - cardBox.left)
        const right = Math.round(cardBox.right - rowsBox.right)
        if (Math.abs(left - border) > 1 || Math.abs(right - border) > 1) problems.push({ left, right, border })
      }
      return problems
    })

    expect(mismatches, `dividers must reach the card edges on ${section}`).toEqual([])
  }
})
