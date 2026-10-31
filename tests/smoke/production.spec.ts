import { appendFileSync } from 'node:fs'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { isSmokeAccountEmail } from '../../lib/smoke-account'

// Read-only: sign in, load the shell, and record which features this deployment
// has on. Nothing here sends a message, boots a computer or calls a provider.
const app = (path: string) => `/mikka${path}`
const email = process.env.SMOKE_OWNER_EMAIL ?? ''
const password = process.env.SMOKE_OWNER_PASSWORD ?? ''
// Comma-separated feature names that must be on; a regression fails the run.
const expected = new Set((process.env.SMOKE_EXPECT_ON ?? '').split(',').map(name => name.trim()).filter(Boolean))

type Probe = { feature: string; path: string; on: (status: number, body: unknown) => boolean }
const probes: Probe[] = [
  { feature: 'coordinator', path: '/api/coordinator/runtime', on: status => status === 200 },
  { feature: 'credentialVault', path: '/api/credentials', on: status => status === 200 },
  { feature: 'approvedWrites', path: '/api/approved-writes', on: (status, body) => status === 200 && (body as { enabled?: unknown })?.enabled === true },
]
// Made once when the account was provisioned; the Coordinator has no computer, so the 电脑 tab is checked on this bot.
const smokeBot = 'Smoke Bot'

async function probe(request: APIRequestContext, { feature, path, on }: Probe) {
  const response = await request.get(app(path), { headers: { 'cache-control': 'no-store' } })
  const body = await response.json().catch(() => null)
  return { feature, status: response.status(), on: on(response.status(), body) }
}

test.beforeAll(() => {
  // Only a tagged account may run here, so its traffic stays marked as test traffic.
  expect(isSmokeAccountEmail(email), 'SMOKE_OWNER_EMAIL must be a +mikka-smoke account').toBe(true)
  expect(password, 'SMOKE_OWNER_PASSWORD is required').not.toBe('')
})

test('the smoke account signs in, reaches its chat and reports feature state', async ({ page, baseURL }) => {
  const signIn = await page.request.post(app('/api/auth/sign-in/email'), { data: { email, password }, headers: { origin: new URL(baseURL!).origin } })
  expect(signIn.status(), 'sign-in').toBe(200)
  const session = await (await page.request.get(app('/api/auth/get-session'))).json()
  expect(session?.user?.email?.toLowerCase()).toBe(email.toLowerCase())

  await page.goto(app('/en'))
  await expect(page).not.toHaveURL(/\/sign-in/)
  await expect(page.locator('main textarea').first(), 'chat composer').toBeVisible()

  const results = [] as { feature: string; status: number | null; on: boolean }[]
  for (const item of probes) results.push(await probe(page.request, item))
  const bot = page.getByRole('button', { name: smokeBot, exact: true })
  await expect(bot, `the "${smokeBot}" bot (docs/production-smoke.md)`).toBeVisible()
  await bot.click()
  // The tab waits on the rollout flag, so give it time before calling it off.
  const computer = await page.getByRole('tab', { name: 'Computer', exact: true }).waitFor({ timeout: 15000 }).then(() => true, () => false)
  results.push({ feature: 'cloudComputer', status: null, on: computer })

  const table = ['| Feature | On | HTTP |', '| --- | --- | --- |', ...results.map(r => `| ${r.feature} | ${r.on ? 'yes' : 'no'} | ${r.status ?? '—'} |`)].join('\n')
  await test.info().attach('features.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
  console.log(table)
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production smoke\n\n${table}\n`)

  expect(results.find(r => r.feature === 'coordinator')?.on, 'coordinator runtime').toBe(true)
  const regressed = results.filter(r => expected.has(r.feature) && !r.on).map(r => r.feature)
  expect(regressed, 'features expected on').toEqual([])
})
