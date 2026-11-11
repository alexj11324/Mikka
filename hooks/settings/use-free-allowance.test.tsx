import assert from 'node:assert/strict'
import { after, afterEach, before, beforeEach, mock, test } from 'node:test'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { SWRConfig } from 'swr'
import { Window } from 'happy-dom'
import type { CardVerificationStatus } from '@/lib/billing/hosted-usage'

let status: CardVerificationStatus | { error: string } | Error
let reads = 0
const forbidden = async () => { throw new Error('Unexpected payment mutation') }
mock.module('next-intl', { namedExports: { useTranslations: (namespace: string) => Object.assign((key: string) => `${namespace}.${key}`, { rich: (key: string) => `${namespace}.${key}` }) } })
mock.module('@/lib/use-action-error', { namedExports: { useActionError: () => () => 'Read failed' } })
mock.module('@/app/actions/billing', { namedExports: { openBillingPortal: forbidden, startPlanCheckout: forbidden } })
mock.module('@/lib/billing/verification-client', { namedExports: {
  getCreditBilling: forbidden, startCardVerification: forbidden, startPointsPurchase: forbidden,
  readCardVerification: async () => { reads++; if (status instanceof Error) throw status; return status },
} })
mock.module('@/hooks/use-live-wait', { namedExports: { useLiveWait: () => async () => undefined } })

const browser = new Window({ url: 'https://fixture.example/' })
let container: HTMLDivElement, root: Root
let createRoot: typeof import('react-dom/client')['createRoot']
let useFreeAllowance: typeof import('./use-billing')['useFreeAllowance']
let FreeAllowanceSection: typeof import('@/components/billing/free-allowance-section')['FreeAllowanceSection']
let allowance: ReturnType<typeof useFreeAllowance>
before(async () => {
  Object.assign(globalThis, { window: browser, document: browser.document, IS_REACT_ACT_ENVIRONMENT: true, HTMLElement: browser.HTMLElement, Element: browser.Element })
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: browser.navigator })
  ;({ createRoot } = await import('react-dom/client'))
  ;({ useFreeAllowance } = await import('./use-billing'))
  ;({ FreeAllowanceSection } = await import('@/components/billing/free-allowance-section'))
})
beforeEach(() => {
  status = new Error('offline'); reads = 0
  container = browser.document.createElement('div') as unknown as HTMLDivElement
  document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove() })
after(() => browser.happyDOM.close())
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) })
function Probe({ enabled }: { enabled: boolean }) { allowance = useFreeAllowance('workspace', enabled); return <FreeAllowanceSection allowance={allowance} /> }
async function render(enabled = true) {
  await act(async () => root.render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}><Probe enabled={enabled} /></SWRConfig>))
  await settle()
}
for (const failure of ['network', 'action'] as const) {
  test(`a free-allowance ${failure} read failure exposes retry rather than disappearing`, async () => {
    if (failure === 'action') status = { error: 'billingProviderFailed' }
    await render()
    assert.equal(allowance.error, 'Read failed')
    assert.ok(container.querySelector('[role="alert"]'))
    assert.ok(![...container.querySelectorAll('button')].some(button => button.textContent?.includes('Billing.allowance.verify')))
    const before = reads
    status = { status: 'verified' }
    const retry = [...container.querySelectorAll('button')].find(button => button.textContent === 'Common.retry')
    assert.ok(retry)
    await act(async () => retry.click())
    await settle()
    assert.ok(reads > before)
    assert.equal(allowance.error, null)
    assert.equal(container.textContent, '', 'a successfully verified card intentionally hides the section')
  })
}
test('a disabled allowance reads nothing and has no failure state', async () => {
  await render(false)
  assert.equal(reads, 0)
  assert.equal(allowance.error, null)
  assert.equal(container.textContent, '')
})
test('a confirmed unavailable allowance shows its actual state without a payment action', async () => {
  status = { status: 'unavailable' }
  await render()
  assert.equal(allowance.error, null)
  assert.ok(container.textContent?.includes('Billing.allowance.unavailable'))
  assert.equal(container.querySelector('button'), null)
})
