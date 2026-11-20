import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, expect } from '@playwright/test'
import sharp from 'sharp'
import { prepareFixture } from './fixture.mjs'
import { startFixture } from './fixtures/start.mjs'
import { fixtureScenario, FIXTURE_TIME, FIXTURE_SCENARIOS } from './fixtures/scenarios.mjs'
import { assertNoFixtureAuthInOutput } from './fixtures/bundle-check.mjs'

const args = process.argv.slice(2), selection = args.find(value => !value.startsWith('--')) ?? 'all'
if (!['all', ...FIXTURE_SCENARIOS].includes(selection) || args.some(value => value !== selection && value !== '--built')) throw new Error('SCREENSHOT_ARGUMENTS_INVALID')
await prepareFixture({ built: args.includes('--built') })
await assertNoFixtureAuthInOutput(process.cwd())
const instance = await startFixture({ scenario: selection })
const layer = instance.build.overlaySha ? 'official' : 'default'
const directory = resolve('.cache/screenshots', layer)
let browser
const results = []

async function capture(scene, editor = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce' })
  try {
    const page = await context.newPage(), failures = []
    page.on('pageerror', () => failures.push('browser-error'))
    await page.clock.setFixedTime(new Date(FIXTURE_TIME))
    await page.goto(`${instance.origin}/__fixture/${scene}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Fixture 工作区', { exact: true }).first()).toBeVisible()
    const data = fixtureScenario(scene)
    if (editor) await page.goto(`${instance.origin}${data.path}&automation=${data.automationId}`, { waitUntil: 'domcontentloaded' })
    if (scene === 'board') {
      await expect(page.getByText('评审 HTTP fake', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('质量验收', { exact: true }).first()).toBeVisible()
    } else if (scene === 'task') {
      await expect(page.getByText('评审 HTTP fake', { exact: true }).first()).toBeVisible()
      await expect(page.getByText('HTTP fake 验收', { exact: true }).first()).toBeVisible()
    } else if (scene === 'automations') {
      if (editor) await expect(page.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('检查待验收任务')
      else await expect(page.getByText('检查待验收任务', { exact: true }).first()).toBeVisible()
    }
    else if (scene === 'pulls') await expect(page.getByText('HTTP fake acceptance', { exact: true }).first()).toBeVisible()
    else if (scene === 'bot-settings') {
      await page.getByRole('button', { name: '概览', exact: true }).first().click()
      await page.getByRole('tab', { name: '详情', exact: true }).click()
      await expect(page.getByText('整理需求、检查实现与验收结果', { exact: true }).first()).toBeVisible()
    } else await expect(page.getByText('全部任务', { exact: true }).first()).toBeVisible()
    await page.evaluate(() => document.fonts.ready)
    await page.evaluate(async () => { await Promise.all([...document.images].map(img => img.complete ? undefined : new Promise(resolve => { img.onload = resolve; img.onerror = resolve }))) })
    assert.equal(failures.length, 0, `SCREENSHOT_BROWSER_ERROR_${scene}`)
    assert.equal(await page.getByText(/UI_SLOT_REQUIRES_OFFICIAL_CLIENT|Required official UI slot|Application error/).count(), 0, 'SCREENSHOT_ERROR_PAGE')
    instance.assertHealthy()
    return await page.screenshot({ animations: 'disabled', caret: 'hide', fullPage: true })
  } finally { await context.close() }
}

try {
  await mkdir(directory, { recursive: true })
  browser = await chromium.launch(process.env.MIKKA_CHROMIUM_EXECUTABLE ? { executablePath: process.env.MIKKA_CHROMIUM_EXECUTABLE } : {})
  for (const scene of instance.scenes) for (const editor of scene === 'automations' ? [false, true] : [false]) {
    const name = editor ? 'automation-editor' : scene, first = await capture(scene, editor), second = await capture(scene, editor)
    const left = await sharp(first).ensureAlpha().raw().toBuffer({ resolveWithObject: true }), right = await sharp(second).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    assert.deepEqual(left.info, right.info, `SCREENSHOT_DIMENSIONS_CHANGED_${name}`)
    let changed = 0
    for (let index = 0; index < left.data.length; index += 4) if (!left.data.subarray(index, index + 4).equals(right.data.subarray(index, index + 4))) changed++
    const ratio = changed / (left.info.width * left.info.height)
    await writeFile(resolve(directory, `${name}.png`), first)
    await writeFile(resolve(directory, `${name}.repeat.png`), second)
    results.push({ scene: name, ratio, maxChangedPixelRatio: 0.001, sha256: createHash('sha256').update(first).digest('hex') })
    assert.ok(ratio <= 0.001, `SCREENSHOT_UNSTABLE_${name}: ${ratio}`)
  }
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ version: 1, target: instance.build.target, revision: instance.build.revision,
    overlaySha: instance.build.overlaySha ?? null, layer, browser: browser.version(), viewport: { width: 1440, height: 1000 }, fixedTime: FIXTURE_TIME, results }, null, 2) + '\n')
  console.log(JSON.stringify({ directory, layer, captured: results.length, stable: true }))
} finally { try { await browser?.close() } finally { await instance.close() } }
