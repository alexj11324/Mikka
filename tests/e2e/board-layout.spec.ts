import { test, expect, register, seedTask, rail, app } from './fixtures'

test('Coordinator 侧栏打开时，已完成折成窄条，其它列不被切掉', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  await seedTask(page, '窄条里的已完成任务', { status: 'done' })
  await page.goto(app('/'))
  await rail(page, '看板').click()

  const strip = page.getByRole('button', { name: '展开已完成列', exact: true })
  await expect(strip).toBeVisible()
  expect((await strip.boundingBox())!.width).toBeLessThanOrEqual(40)
  await expect(page.getByText('窄条里的已完成任务', { exact: true })).toHaveCount(0)

  // Every other column fits beside the sidebar without scrolling.
  const board = page.getByRole('region', { name: '横向滚动任务看板', exact: true })
  expect(await board.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true)

  await strip.click()
  await expect(page.getByText('窄条里的已完成任务', { exact: true })).toBeVisible()
})
