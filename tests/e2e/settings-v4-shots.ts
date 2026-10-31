import type { Page, TestInfo } from '@playwright/test'

/** Attaches the settings content in light and dark, as the review page shows each state. */
export async function attachLightDark(page: Page, testInfo: TestInfo, name: string) {
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await testInfo.attach(`${name}-${scheme}`, { body: await page.screenshot({ fullPage: true, mask: [page.locator('[data-slot="avatar"]')] }), contentType: 'image/png' })
  }
  await page.emulateMedia({ colorScheme: 'light' })
}
