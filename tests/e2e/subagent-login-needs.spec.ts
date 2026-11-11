import { expect, test, type Page } from '@playwright/test'

// BLOCKED: this suite drove the Next page app/[locale]/preview/subagent-login,
// a test harness gated by MIKKA_CREDENTIAL_HARNESS. The app renders no Next
// pages, so the harness page is gone and components/coordinator/subagent-login-needs.tsx
// currently has no browser entry point. Keep the cases and unskip them together
// with a harness route that mounts the component (Components/, not a lookalike).
const HARNESS_MISSING = true
test.skip(HARNESS_MISSING, 'subagent-login harness page was removed with the Next page layer')

const BOT = '00000000-0000-4000-8000-0000000000b0'
const WORKSPACE = '00000000-0000-4000-8000-0000000000c0'
const SUB = '00000000-0000-4000-8000-0000000000a1'
const OTHER = '00000000-0000-4000-8000-0000000000a2'
const PREFIX = `/mikka/api/bots/${BOT}/subagents/${SUB}/credentials`
const SECRET = 'hunter2-secret'

type Update = { subagentId?: string; botId?: string; state?: string; needs?: unknown }
const update = (over: Update) => ({ botId: BOT, subagentId: SUB, task: '查 Cloudflare 账单', state: 'needs_you', step: '需要登录', needs: { kind: 'login', site: 'dash.cloudflare.com' }, ...over })

/** Serves bounded cursor pages through the same scope used by the live provider. */
async function computerEvents(page: Page, updates: Update[]) {
  const events = updates.map((data, index) => ({ id: String(index + 1), data: update(data) }))
  // This isolated rendering fixture has no gateway. An unavailable ticket uses
  // the normal slow fallback; the test never opens a real remote WebSocket.
  await page.route('**/mikka/api/live/ticket*', route => route.fulfill({ status: 503, json: { error: 'fixtureGatewayUnavailable' } }))
  await page.route('**/mikka/api/computer/events*', route => {
    const url = new URL(route.request().url())
    expect(url.searchParams.get('workspace')).toBe(WORKSPACE)
    const after = url.searchParams.get('after') ?? '0'
    expect(after).toMatch(/^(0|[1-9][0-9]*)$/)
    const remaining = events.filter(event => BigInt(event.id) > BigInt(after))
    const batch = remaining.slice(0, 100)
    return route.fulfill({
      headers: { 'cache-control': 'no-store' },
      json: { events: batch, cursor: batch.at(-1)?.id ?? after, hasMore: remaining.length > batch.length },
    })
  })
}

test('a sub-agent login need renders the card against its own credential API', async ({ page }) => {
  await computerEvents(page, [
    {},
    {},
    { subagentId: '00000000-0000-4000-8000-0000000000a5', state: 'running' },
    { subagentId: OTHER, needs: { kind: 'code', site: 'github.com' } },
    { subagentId: '00000000-0000-4000-8000-0000000000a3', botId: '00000000-0000-4000-8000-0000000000ff' },
    { subagentId: '00000000-0000-4000-8000-0000000000a4', needs: { kind: 'login', site: 'javascript:alert(1)' } },
  ])
  const posts: { url: string; body: string }[] = []
  await page.route(`**${PREFIX}/challenge`, route => { posts.push({ url: route.request().url(), body: route.request().postData() ?? '' }); return route.fulfill({ json: { nonce: 'n'.repeat(43), origin: 'https://dash.cloudflare.com', expiresIn: 300 } }) })
  await page.route(`**${PREFIX}`, async route => {
    posts.push({ url: route.request().url(), body: route.request().postData() ?? '' })
    await new Promise(resolve => setTimeout(resolve, 500))
    await route.fulfill({ json: { attemptId: '11111111-1111-4111-8111-111111111111', status: 'signed_in', origin: 'https://dash.cloudflare.com' } })
  })
  await page.goto('/mikka/zh-CN/preview/subagent-login')
  const needs = page.getByTestId('subagent-login-needs')
  await expect(needs.getByRole('button', { name: '登录 dash.cloudflare.com' })).toBeVisible()
  // Only the one actionable login need: no card for a repeated event, a still-running sub-agent, code needs, other bots, or non-http sites.
  await expect(needs.getByRole('button', { name: /^登录 / })).toHaveCount(1)
  await needs.getByRole('button', { name: '登录 dash.cloudflare.com' }).click()
  await page.getByRole('textbox', { name: '邮箱' }).fill('alex@mikka.app')
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByTestId('credential-login-done')).toContainText('已登录 dash.cloudflare.com')
  await expect(needs).toHaveAttribute('data-signed-in', '1')
  expect(posts.map(post => new URL(post.url).pathname)).toEqual([`${PREFIX}/challenge`, PREFIX])
  expect(JSON.parse(posts[0].body)).toEqual({ site: 'https://dash.cloudflare.com' })
  expect(JSON.parse(posts[1].body)).toMatchObject({ origin: 'https://dash.cloudflare.com', username: 'alex@mikka.app', password: SECRET })
  expect(await page.content()).not.toContain(SECRET)
})

test('the card goes away once the sub-agent moves on', async ({ page }) => {
  await computerEvents(page, [{}, { state: 'running', needs: null }])
  await page.goto('/mikka/zh-CN/preview/subagent-login')
  await expect(page.getByRole('main')).toBeVisible()
  await page.waitForTimeout(500)
  await expect(page.getByTestId('subagent-login-needs')).toHaveCount(0)
})

test('a BE-17 rejection from the sub-agent route shows its reason', async ({ page }) => {
  await computerEvents(page, [{}])
  await page.route(`**${PREFIX}/challenge`, route => route.fulfill({ json: { nonce: 'n'.repeat(43), origin: 'https://dash.cloudflare.com', expiresIn: 300 } }))
  await page.route(`**${PREFIX}`, route => route.fulfill({ json: { attemptId: '11111111-1111-4111-8111-111111111111', status: 'rejected', reason: 'invalidCredentials', origin: 'https://dash.cloudflare.com' } }))
  await page.goto('/mikka/zh-CN/preview/subagent-login')
  await page.getByRole('button', { name: '登录 dash.cloudflare.com' }).click()
  await page.getByRole('textbox', { name: '邮箱' }).fill('alex@mikka.app')
  await page.getByLabel('密码', { exact: true }).fill(SECRET)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('邮箱或密码不对')).toBeVisible()
})
