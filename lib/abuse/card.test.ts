import assert from 'node:assert/strict'
import { after, before, beforeEach, mock, test } from 'node:test'
let admin = true
const bindings = new Map<string, { workspaceId: string; customerId: string }>(),
  verified: string[][] = []
const requests: Array<{ url: string; body: URLSearchParams }> = []
const saved = {
  secret: process.env.STRIPE_SECRET_KEY,
  webhook: process.env.STRIPE_WEBHOOK_SECRET,
}
mock.module(new URL('../db/index.ts', import.meta.url).href, {
  namedExports: {
    pool: {
      query: async (sql: string, values: string[]) => {
        if (sql.startsWith('INSERT')) {
          bindings.set(values[0], {
            workspaceId: values[1],
            customerId: values[2],
          })
          return { rows: [] }
        }
        if (sql.includes('WHERE id='))
          return {
            rows: bindings.has(values[0]) ? [bindings.get(values[0])] : [],
          }
        return { rows: [] }
      },
    },
  },
})
mock.module(new URL('../workspace-db.ts', import.meta.url).href, {
  namedExports: {
    workspaceDb: {
      transaction: async (fn: (tx: unknown) => Promise<void>) => fn({}),
    },
  },
})
mock.module(new URL('../workspace-access.ts', import.meta.url).href, {
  namedExports: {
    WorkspaceError: class extends Error {},
    requireWorkspace: async () => {
      if (!admin) throw Error('workspaceAccessDenied')
    },
  },
})
mock.module(new URL('./runtime.ts', import.meta.url).href, {
  namedExports: {
    hostedUsage: {
      verify: async (...args: string[]) => {
        verified.push(args)
      },
    },
  },
})
let createCardSetup: (typeof import('./card'))['createCardSetup'],
  applyCardSetup: (typeof import('./card'))['applyCardSetup']
before(async () => {
  ;({ createCardSetup, applyCardSetup } = await import('./card'))
})
after(() => {
  if (saved.secret === undefined) delete process.env.STRIPE_SECRET_KEY
  else process.env.STRIPE_SECRET_KEY = saved.secret
  if (saved.webhook === undefined) delete process.env.STRIPE_WEBHOOK_SECRET
  else process.env.STRIPE_WEBHOOK_SECRET = saved.webhook
})
beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fixture'
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_fixture'
  bindings.clear()
  requests.length = 0
  verified.length = 0
  admin = true
})
const fake = (async (url: string, init?: RequestInit) => {
  const body = new URLSearchParams(String(init?.body ?? ''))
  requests.push({ url, body })
  if (url.endsWith('/customers')) return Response.json({ id: 'cus_fixture' })
  if (url.endsWith('/setup_intents'))
    return Response.json({
      id: 'seti_fixture',
      client_secret: 'fixture_client_secret',
    })
  return Response.json({
    type: 'card',
    customer: 'cus_fixture',
    card: { fingerprint: 'fixture_card' },
  })
}) as typeof fetch
test('only an admin can create a zero-charge SetupIntent', async () => {
  admin = false
  await assert.rejects(
    createCardSetup('actor', 'workspace', fake),
    /workspaceAccessDenied/,
  )
  assert.equal(requests.length, 0)
  admin = true
  assert.deepEqual(await createCardSetup('actor', 'workspace', fake), {
    clientSecret: 'fixture_client_secret',
  })
  const setup = requests.find((row) => row.url.endsWith('/setup_intents'))!
  assert.equal(setup.body.has('amount'), false)
  assert.equal(setup.body.get('customer'), 'cus_fixture')
  assert.equal(setup.body.get('metadata[workspaceId]'), 'workspace')
  assert.equal(setup.body.get('allowed_payment_method_types[0]'), 'card')
})
test('webhook uses locally stored intent/customer, ignores foreign bindings, takes fingerprint from Stripe', async () => {
  await createCardSetup('actor', 'workspace', fake)
  await applyCardSetup(
    {
      id: 'foreign',
      status: 'succeeded',
      customer: 'cus_fixture',
      payment_method: 'pm_fixture',
    },
    fake,
  )
  await applyCardSetup(
    {
      id: 'seti_fixture',
      status: 'succeeded',
      customer: 'cus_other',
      payment_method: 'pm_fixture',
    },
    fake,
  )
  assert.equal(verified.length, 0)
  await applyCardSetup(
    {
      id: 'seti_fixture',
      status: 'succeeded',
      customer: 'cus_fixture',
      payment_method: 'pm_fixture',
      metadata: { workspaceId: 'attacker' },
    },
    fake,
  )
  assert.deepEqual(verified, [['workspace', 'cus_fixture', 'fixture_card']])
})

test('Link email prefill and Link-saved cards use the normal card fingerprint claim', async () => {
  const result = await createCardSetup(
    'actor',
    'workspace',
    fake,
    'owner@example.com',
  )
  assert.equal(requests[0].body.get('email'), 'owner@example.com')
  assert.deepEqual(result.paymentElementOptions, {
    defaultValues: { billingDetails: { email: 'owner@example.com' } },
  })
  const linkFetch = (async () =>
    Response.json({
      type: 'card',
      customer: 'cus_fixture',
      card: { fingerprint: 'fixture_card', wallet: { type: 'link' } },
    })) as typeof fetch
  await applyCardSetup(
    {
      id: 'seti_fixture',
      status: 'succeeded',
      customer: 'cus_fixture',
      payment_method: 'pm_link_card',
    },
    linkFetch,
  )
  assert.deepEqual(verified, [['workspace', 'cus_fixture', 'fixture_card']])
})
