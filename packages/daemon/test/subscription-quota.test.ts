import { expect, it } from 'vitest'
import { readSubscriptionQuota } from '../src/subscription-quota'

const lease = { accessToken: 'fixture-access', chatgptAccountId: 'fixture-account' }
for (const provider of ['codex', 'claude'] as const) {
  const body = () => provider === 'codex'
    ? { credits: { has_credits: false, unlimited: false }, rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 18000 } } }
    : { extra_usage: { is_enabled: false }, five_hour: { utilization: 20 } }
  it(`${provider} quota uses only a platform lease and honest Mikka headers`, async () => {
    let calls = 0
    const fetcher = (async (url, options) => {
      calls++
      expect(String(url)).toBe(provider === 'codex' ? 'https://chatgpt.com/backend-api/wham/usage' : 'https://api.anthropic.com/api/oauth/usage')
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer fixture-access', 'User-Agent': 'Mikka/1.0' })
      expect(options?.redirect).toBe('error')
      return Response.json(body())
    }) as typeof fetch
    const quota = await readSubscriptionQuota(provider, lease, fetcher)
    expect(quota.status).toBe('ok')
    expect(quota.windows[0]?.used).toBe(0.2)
    expect(quota.source).toBe('official')
    expect(JSON.stringify(quota)).not.toContain('fixture-access')
    expect(calls).toBe(1)
  })
  it(`${provider} refuses unknown or enabled credit fallback`, async () => {
    for (const proof of [undefined, provider === 'codex' ? { has_credits: true, unlimited: false } : { is_enabled: true }]) {
      const data: Record<string, unknown> = body()
      data[provider === 'codex' ? 'credits' : 'extra_usage'] = proof
      const result = await readSubscriptionQuota(provider, lease, (async () => Response.json(data)) as typeof fetch)
      expect(result.status).toBe('unknown')
    }
  })
  it(`${provider} does not refresh or retry a denied lease`, async () => {
    let calls = 0
    const result = await readSubscriptionQuota(provider, lease, (async () => { calls++; return new Response('fixture-access private diagnostic', { status: 401 }) }) as typeof fetch)
    expect(result.status).toBe('unknown')
    expect(calls).toBe(1)
    expect(JSON.stringify(result)).not.toContain('fixture-access')
  })
}
