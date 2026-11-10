'use client'

/**
 * 设置 › 计费's page: plan, 免费额度, 余额 and 账单记录. The open-source UI draws
 * the shared page; a UI layer may draw its own from the same props
 * (docs/ui-overlay.md). Nothing here collects payment details: every payment
 * step is Stripe's own page.
 */
export { BillingPageView as BillingPage } from '@/components/settings/billing-view'
