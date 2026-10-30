// Manual re-verification of crawl "no effect"/"error" items.
import { writeFileSync } from 'node:fs'
import { launch, log, sleep, OUT, APP, opened, clearOpened } from './lib.mjs'
const r = {}
const { app, page } = await launch('/tmp/qa-electron')
page.setDefaultTimeout(10000)
const errs = []
page.on('pageerror', e => errs.push(String(e))); page.on('console', m => m.type() === 'error' && errs.push(m.text().slice(0, 300)))
const go = async u => { await page.goto(u, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle').catch(() => {}); await sleep(1500) }
const step = async (name, fn) => { try { r[name] = await fn() } catch (e) { r[name] = 'ERR ' + String(e).split('\n')[0].slice(0, 200) } log(name, JSON.stringify(r[name]).slice(0, 400)) }
// Back to Chinese first
await go(`${APP}/en/settings?section=preferences`)
await step('langBack', async () => { await page.getByRole('button', { name: 'Chinese (Simplified)' }).click(); await sleep(2500); return page.url() })
await go(`${APP}/settings?section=preferences`)
const themeState = () => page.evaluate(() => ({ cls: document.documentElement.className.slice(0, 80), scheme: getComputedStyle(document.documentElement).colorScheme, bg: getComputedStyle(document.body).backgroundColor }))
await step('theme', async () => {
  const out = { before: await themeState() }
  for (const n of ['深色', '浅色', '跟随系统']) { const b = page.getByRole('button', { name: n, exact: true }); await b.click(); await sleep(800); out[n] = { ...(await themeState()), pressed: await b.getAttribute('aria-pressed'), checked: await b.getAttribute('aria-checked'), dataState: await b.getAttribute('data-state') } }
  out.nativeTheme = await app.evaluate(({ nativeTheme }) => ({ source: nativeTheme.themeSource, dark: nativeTheme.shouldUseDarkColors }))
  return out
})
await page.getByRole('button', { name: '深色', exact: true }).click(); await sleep(800); await page.screenshot({ path: `${OUT}/shots/check3-theme-dark.png` })
await page.getByRole('button', { name: '跟随系统', exact: true }).click(); await sleep(500)
await step('toggleSidebar', async () => {
  const b = page.getByRole('button', { name: 'Toggle Sidebar' }).first()
  const vis = () => page.evaluate(() => { const s = document.querySelector('[data-slot=sidebar]'); return s ? { state: s.getAttribute('data-state'), collapsible: s.getAttribute('data-collapsible'), w: Math.round(s.getBoundingClientRect().width) } : null })
  const before = await vis(); const box = await b.boundingBox(); await b.click(); await sleep(800); const after = await vis(); await b.click().catch(() => {}); await sleep(500)
  return { before, after, buttonBox: box, srText: await b.innerText().catch(() => '') }
})
await go(`${APP}/settings?section=notifications`)
await step('notifyTiming', async () => { const out = {}; for (const n of ['立即', '电脑不在时']) { const b = page.getByRole('button', { name: new RegExp(n) }).first(); if (!(await b.count())) { out[n] = 'not found'; continue } await b.click(); await sleep(800); out[n] = { pressed: await b.getAttribute('aria-pressed'), state: await b.getAttribute('data-state'), checked: await b.getAttribute('aria-checked') } } out.buttons = await page.getByRole('button').allInnerTexts(); return out })
await go(`${APP}/settings?section=activity`)
await step('activityFilters', async () => { const out = {}; for (const b of await page.getByRole('button').all()) { const t = (await b.innerText()).trim(); if (!['全部', '用了我的账号', '提醒'].includes(t)) continue; await b.click(); await sleep(700); out[t] = { pressed: await b.getAttribute('aria-pressed'), state: await b.getAttribute('data-state'), variant: await b.getAttribute('data-variant') ?? await b.getAttribute('data-button-variant') } } out.allButtons = (await page.getByRole('button').allInnerTexts()).slice(0, 30); return out })
await go(`${APP}/settings?section=general`)
await step('generalName', async () => { const inputs = await page.locator('input').evaluateAll(xs => xs.map(x => ({ v: x.value, ro: x.readOnly, dis: x.disabled, label: x.getAttribute('aria-label') }))); return inputs })
await page.screenshot({ path: `${OUT}/shots/check3-general.png` })
await go(`${APP}?section=artifacts`)
await step('artifactFilters', async () => { const out = {}; for (const t of ['全部', '文档', '网页']) { const b = page.getByRole('button', { name: t, exact: true }).first(); await b.click(); await sleep(600); out[t] = { pressed: await b.getAttribute('aria-pressed'), state: await b.getAttribute('data-state'), cls: (await b.getAttribute('class')).match(/bg-\S+/g)?.slice(0, 3) } } return out })
// Home with the browser pane closed
await go(`${APP}?section=coordinator`)
await step('browserPaneOpen', async () => page.getByRole('textbox', { name: '地址' }).count())
if (r.browserPaneOpen) await page.getByRole('button', { name: '关闭浏览器' }).click().then(() => sleep(800))
await step('homeItems', async () => {
  const out = {}
  for (const [role, name] of [['tab', '全部线程'], ['tab', '概览'], ['button', '搜索'], ['button', '加宽右栏'], ['button', '关闭右栏'], ['button', '展开或收起侧栏边轨'], ['button', 'Coordinator']]) {
    const loc = page.getByRole(role, { name, exact: true }).first()
    if (!(await loc.count())) { out[name] = 'not present'; continue }
    const w = () => page.evaluate(() => [...document.querySelectorAll('aside, [data-slot=context-panel], [role=complementary]')].map(e => Math.round(e.getBoundingClientRect().width)).join(','))
    const w0 = await w(); const s0 = await page.evaluate(() => document.body.innerText.length)
    try { await loc.click({ timeout: 5000 }); await sleep(900); out[name] = { ok: true, widths: `${w0} -> ${await w()}`, text: `${s0} -> ${await page.evaluate(() => document.body.innerText.length)}`, selected: await loc.getAttribute('aria-selected').catch(() => null) } } catch (e) { out[name] = 'ERR ' + String(e).split('\n')[0].slice(0, 120) }
    if (name === '关闭右栏') { await page.screenshot({ path: `${OUT}/shots/check3-right-closed.png` }) }
    await page.keyboard.press('Escape'); await sleep(300)
  }
  return out
})
await step('fileChooser', async () => { await go(`${APP}?section=coordinator`); const [fc] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null), page.getByRole('button', { name: '添加文件' }).first().click()]); return fc ? { multiple: fc.isMultiple() } : 'no filechooser event' })
await page.keyboard.press('Escape')
// Browser pane in Electron
await step('browserPane', async () => {
  await go(`${APP}?section=coordinator`)
  await page.getByRole('button', { name: '浏览器' }).first().click(); await sleep(800)
  const addr = page.getByRole('textbox', { name: '地址' })
  const out = {}
  for (const u of ['http://localhost:3100/mikka/sign-in', 'https://example.com', 'example.com']) {
    await clearOpened(app)
    await addr.fill(u); await addr.press('Enter'); await sleep(4000)
    out[u] = { frameSrc: await page.locator('iframe[title="网页"]').getAttribute('src').catch(() => null), invalid: await addr.getAttribute('aria-invalid'), opened: await opened(app), url: page.url() }
  }
  await page.screenshot({ path: `${OUT}/shots/check3-browser-pane.png` })
  await page.getByRole('button', { name: '关闭浏览器' }).click().catch(() => {})
  return out
})
await go(`${APP}?section=projects`)
await step('projectFilter', async () => page.getByRole('combobox', { name: '筛选项目状态' }).evaluate(e => ({ tag: e.tagName, options: e.tagName === 'SELECT' ? [...e.options].map(o => o.text) : null, expanded: e.getAttribute('aria-expanded') })))
await step('projectFilterClick', async () => { const c = page.getByRole('combobox', { name: '筛选项目状态' }); await c.click(); await sleep(800); const lb = await page.locator('[role=listbox],[role=menu]').count(); await page.screenshot({ path: `${OUT}/shots/check3-project-filter.png` }); await page.keyboard.press('Escape'); return { listbox: lb, expanded: await c.getAttribute('aria-expanded') } })
await go(`${APP}?section=plugins`)
await step('skillsTab', async () => { await page.getByRole('tab', { name: '技能' }).click(); await sleep(2500); await page.screenshot({ path: `${OUT}/shots/check3-skills-503.png` }); return (await page.locator('[role=tabpanel]').innerText().catch(() => '')).slice(0, 300) })
r.errors = errs
writeFileSync(`${OUT}/check3.json`, JSON.stringify(r, null, 1))
await app.close()
