import { test, expect, register, seedTask, rail, app } from './fixtures'

for (const width of [1280, 1440]) {
  test(`${width}px，Coordinator 侧栏打开：列宽固定 300，只有已完成折成窄条，放不下就横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await register(page)
    await seedTask(page, '窄条里的已完成任务', { status: 'done' })
    await seedTask(page, '待整理里的任务', { status: 'backlog' })
    await page.goto(app('/'))
    await rail(page, '看板').click()

    const board = page.getByRole('region', { name: '横向滚动任务看板', exact: true })
    const strip = page.getByRole('button', { name: '展开已完成列', exact: true })
    await expect(strip).toBeVisible()
    expect((await strip.boundingBox())!.width).toBe(40)
    await expect(page.getByRole('button', { name: '展开待整理列', exact: true })).toHaveCount(0)
    await expect(page.getByText('窄条里的已完成任务', { exact: true })).toHaveCount(0)

    // The strip's name reads top to bottom: no two glyphs share a line.
    const glyphs = await strip.locator('span[aria-hidden="true"] > span').evaluateAll(spans => spans.map(span => span.getBoundingClientRect()).map(box => ({ top: box.top, height: box.height })))
    expect(glyphs.map((_, index) => index)).toEqual([0, 1, 2])
    for (let index = 1; index < glyphs.length; index += 1) expect(glyphs[index].top).toBeGreaterThanOrEqual(glyphs[index - 1].top + glyphs[index - 1].height - 1)

    // Every expanded column is 300px (R-25); the board scrolls instead of squeezing them.
    const columns = await board.locator('[data-slot="kanban-column"]').evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().width)))
    expect(columns.filter(value => value !== 40)).toEqual([300, 300, 300, 300])
    const metrics = await board.evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }))
    expect(metrics.scroll).toBeGreaterThan(metrics.client)

    // Keyboard scrolling on the board region (ArrowRight, End, Home).
    await board.focus()
    await page.keyboard.press('ArrowRight')
    await expect.poll(() => board.evaluate(el => el.scrollLeft)).toBeGreaterThan(0)
    await page.keyboard.press('End')
    await expect.poll(() => board.evaluate(el => el.scrollLeft + el.clientWidth)).toBeGreaterThanOrEqual(metrics.scroll - 1)
    await page.keyboard.press('Home')
    await expect.poll(() => board.evaluate(el => el.scrollLeft)).toBe(0)

    await strip.click()
    await expect(page.getByText('窄条里的已完成任务', { exact: true })).toBeVisible()
  })
}

test('看板工具栏：范围切换、筛选和筛选条同高', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await register(page)
  await page.goto(app('/'))
  await rail(page, '看板').click()

  const toolbar = page.getByRole('toolbar', { name: '看板工具栏', exact: true })
  const scope = toolbar.getByRole('group', { name: '任务范围', exact: true })
  const filter = toolbar.getByRole('button', { name: '筛选', exact: true })
  // The default filter is 负责人: 我, shown as one chip.
  const chip = toolbar.getByRole('group', { name: '负责人', exact: true })
  await expect(chip).toContainText('我')
  await expect(chip.getByRole('button', { name: '移除负责人筛选', exact: true })).toBeVisible()

  const heights = await Promise.all([scope, filter, chip].map(async item => (await item.boundingBox())!.height))
  expect(heights).toEqual([28, 28, 28])
})
