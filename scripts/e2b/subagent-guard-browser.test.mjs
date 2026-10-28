// Synthetic local Chromium only: inspect the exact CDP snapshots used by the gateway.
import { chromium } from '@playwright/test'
import { existsSync } from 'node:fs'

const executablePath = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find(existsSync)
if (!executablePath) throw new Error('Chromium is required for the guard regression')
const browser = await chromium.launch({ executablePath, headless: true, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage()
  const cdp = await page.context().newCDPSession(page)
  const results = {}
  async function capture(name) {
    results[name] = {
      frames: await cdp.send('Page.getFrameTree'),
      document: await cdp.send('DOM.getDocument', { depth: -1, pierce: true }),
      evaluation: await cdp.send('Runtime.evaluate', { expression: process.argv[2], returnByValue: true }),
    }
  }
  await page.setContent('<input name="otp">')
  await capture('empty')
  await page.locator('input').fill('123456')
  await capture('otp')
  await page.locator('input').fill('')
  await capture('cleared')
  await page.setContent('<iframe srcdoc="<input name=otp value=123456>"></iframe>')
  await capture('iframe')
  for (const mode of ['open', 'closed']) {
    await page.setContent('<div id="host"></div>')
    await page.evaluate(mode => { const root = document.querySelector('#host').attachShadow({ mode }); root.innerHTML = '<input name="otp" value="123456">' }, mode)
    await capture(`${mode}-shadow`)
  }
  process.stdout.write(JSON.stringify(results))
} finally { await browser.close() }
