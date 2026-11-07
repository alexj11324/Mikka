import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { runDeployedBrowserSmoke, selectBrowserTeamWorkspace } from '../../scripts/acceptance/deployed-browser-session.mjs'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { isSmokeAccountEmail } from '../../lib/smoke-account'

// Read-only: sign in, load the shell, and record which features this deployment
// has on. Nothing here sends a message, boots a computer or calls a provider.
const app = (path: string) => `/mikka${path}`
const email = process.env.SMOKE_OWNER_EMAIL ?? ''
const password = process.env.SMOKE_OWNER_PASSWORD ?? ''
// Comma-separated feature names that must be on; a regression fails the run.
const expected = new Set((process.env.SMOKE_EXPECT_ON ?? '').split(',').map(name => name.trim()).filter(Boolean))

type Probe = { feature: string; stage: string; path: string; on: (status: number, body: unknown) => boolean }
const probes: Probe[] = [
  { feature: 'coordinator', stage: 'feature-coordinator', path: '/api/coordinator/runtime', on: status => status === 200 },
  { feature: 'credentialVault', stage: 'feature-credential-vault', path: '/api/credentials', on: status => status === 200 },
  { feature: 'approvedWrites', stage: 'feature-approved-writes', path: '/api/approved-writes', on: (status, body) => status === 200 && (body as { enabled?: unknown })?.enabled === true },
]

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
  const smoke = async (scope?: {
    signInAttempted(): void; identityConfirmed(): void; teamWorkspaceConfirmed(proof: unknown): void
    step<T>(stage: string, operation: () => Promise<T>): Promise<T>
  }) => {
    // Both entry modes execute the same checks; deployed mode retains only the
    // closed stage name when a callback fails, never its value or exception.
    const step = <T>(stage: string, operation: () => Promise<T>): Promise<T> =>
      scope ? scope.step(stage, operation) : operation()
    await step('sign-in', async () => {
      scope?.signInAttempted()
      const signIn = await page.request.post(app('/api/auth/sign-in/email'), { data: { email, password }, headers: { origin: new URL(baseURL!).origin } })
      expect(signIn.status(), 'sign-in').toBe(200)
    })
    const session = await step('session-identity', async () => {
      const value = await (await page.request.get(app('/api/auth/get-session'))).json()
      expect(value?.user?.email?.toLowerCase()).toBe(email.toLowerCase())
      scope?.identityConfirmed()
      return value
    })
    // Both entry modes use the same authenticated context. A normal member is
    // eligible; never infer the team from its name or pick the first choice.
    await step('team-selection', async () => {
      const team = await selectBrowserTeamWorkspace({ page, baseURL, ownerId: session?.user?.id })
      scope?.teamWorkspaceConfirmed(team)
      await test.info().attach('team-workspace.json', { body: JSON.stringify(team), contentType: 'application/json' })
    })

    await step('navigation', async () => { await page.goto(app('/en')) })
    await step('signed-in-route', async () => { await expect(page).not.toHaveURL(/\/sign-in/) })
    // The current workspace's Coordinator has its own Computer panel. Do not
    // depend on a separately provisioned bot in a different personal workspace.
    await step('coordinator-selection', async () => {
      const coordinator = page.getByRole('button', { name: 'Coordinator', exact: true })
        .or(page.getByRole('button', { name: 'Coordinator, working', exact: true }))
      await expect(coordinator, 'current workspace Coordinator').toBeVisible()
      await coordinator.click()
      await expect(coordinator).toHaveAttribute('aria-current', 'page')
    })
    await step('composer', async () => {
      await expect(page.locator('main textarea').first(), 'chat composer').toBeVisible()
    })

    const results = [] as { feature: string; status: number | null; on: boolean }[]
    for (const item of probes) results.push(await step(item.stage, () => probe(page.request, item)))
    const panel = await step('computer-panel', async () => {
      // The existing button opens the narrow-screen sheet or a closed column.
      // On a wide screen the already-open column hides this button.
      const open = page.getByRole('button', { name: 'Open panel', exact: true })
      if (await open.isVisible()) await open.click()
      const current = page.getByRole('complementary', { name: 'Right panel', exact: true })
      await expect(current, 'current Coordinator panel').toBeVisible()
      return current
    })
    // Read the tab's presence; clicking it would mount the computer view.
    const computer = await step('computer-tab', () => panel.getByRole('tab', { name: 'Computer', exact: true })
      .waitFor({ timeout: 15000 }).then(() => true, () => false))
    results.push({ feature: 'cloudComputer', status: null, on: computer })

    const table = ['| Feature | On | HTTP |', '| --- | --- | --- |', ...results.map(r => `| ${r.feature} | ${r.on ? 'yes' : 'no'} | ${r.status ?? '—'} |`)].join('\n')
    await test.info().attach('features.json', { body: JSON.stringify(results, null, 2), contentType: 'application/json' })
    console.log(table)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Production smoke\n\n${table}\n`)

    await step('required-coordinator', async () => {
      expect(results.find(r => r.feature === 'coordinator')?.on, 'coordinator runtime').toBe(true)
    })
    await step('required-features', async () => {
      const regressed = results.filter(r => expected.has(r.feature) && !r.on).map(r => r.feature)
      expect(regressed, 'features expected on').toEqual([])
    })

  }
  const mode = process.env.MIKKA_ACCEPTANCE_TARGET_MODE
  if (mode === undefined) return smoke()
  if (mode !== 'deployed-target') throw new Error('browser_mode_rejected')
  let event: unknown, attestation: unknown
  try {
    event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH!, 'utf8'))
    attestation = JSON.parse(await readFile('production-read-cache-report/attestation.json', 'utf8'))
  } catch { throw new Error('deployed_browser_input_invalid') }
  await runDeployedBrowserSmoke({ page, baseURL, smoke, event, attestation })
})
