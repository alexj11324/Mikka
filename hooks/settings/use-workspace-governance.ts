'use client'

import { useCallback, useState } from 'react'
import useSWR, { unstable_serialize, useSWRConfig } from 'swr'
import { useTranslations } from 'next-intl'
import { withBasePath } from '@/lib/base-path'

/**
 * A Shared workspace's plan, seats, team usage report and approval templates
 * (#1608 Team Free / Pro, #1640 「Claude 界面交接」). Plan and role are checked
 * apart by the server; the UI shows what the summary says it may do and never
 * treats a 403 as something an upgrade fixes. The open-source UI draws none of
 * it; the hosted layer does (docs/ui-overlay.md, slot `settings-governance`).
 */

export type GovernanceDetail = 'access_denied' | 'seat_limit' | 'feature_unavailable' | 'last_owner' | 'workspace_attached' | 'personal_workspace' | 'invalid_request' | 'template_limit' | 'not_found' | 'plan_changed'
export type GovernancePermissions = { install_dependency?: 'allow' | 'ask' | 'deny'; write_outside_repo?: 'ask' | 'deny'; git_push?: 'allow' | 'deny'; network?: 'allow' | 'ask' | 'deny' }
export type GovernanceRules = { approvalMode?: 'ask' | 'read_only'; networkAllow?: string[]; permissions?: GovernancePermissions }
export type GovernanceTemplate = { id: string; workspaceId: string; name: string; rules: GovernanceRules; createdBy: string; createdAt: string; updatedAt: string }
export type GovernanceSummary = {
  organizationId: string | null
  plan: string
  edition: string
  activeHumans: number
  workspaceActiveHumans: number
  /** null: no limit. */
  activeHumanLimit: number | null
  /** Already over the limit; says nothing about whether one more seat fits. */
  overLimit: boolean
  hostedMaxInFlight: number
  usageExport: boolean
  approvalTemplates: boolean
  approvalTemplateLimit: number
  canEdit: boolean
  templates: GovernanceTemplate[]
  /** Enterprise (#1642): admins only, the Organizations they own or administer, to bind this workspace to. */
  organizations?: { id: string; name: string; role: 'owner' | 'admin' }[]
}
export type GovernanceUsage = {
  from: string
  toExclusive: string
  currency: 'USD'
  costUnit: 'microUSD'
  hosted: { day: string; model: string; requests: number | string; inputTokens: string; outputTokens: string; costMicroUsd: string; freeMicroUsd: string; purchasedMicroUsd: string }[]
  runs: { status: string; count: number }[]
}

export class GovernanceRequestError extends Error {
  constructor(public status: number, public detail: GovernanceDetail | 'default') { super(detail); this.name = 'GovernanceRequestError' }
}

const base = (workspaceId: string) => `/api/workspaces/${encodeURIComponent(workspaceId)}/governance`

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(withBasePath(url), { cache: 'no-store', ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: { detail?: GovernanceDetail } } | null
    throw new GovernanceRequestError(response.status, body?.error?.detail ?? 'default')
  }
  return response.json() as Promise<T>
}

/** The message for a governance refusal, from the backend's own copy (RunErrors.governance_denied). */
export function useGovernanceErrorText() {
  const t = useTranslations('RunErrors.governance_denied')
  return (error: unknown) => {
    const detail = error instanceof GovernanceRequestError ? error.detail : 'default'
    return t.has(detail as never) ? t(detail as never) : t('default')
  }
}

export const governanceKey = (workspaceId: string) => ['governance', workspaceId] as const
/** The summary's key as the live layer names it: SettingsDataPreloader revalidates it on the
 * existing `workspace_settings` invalidation, with the member list (no polling of its own). */
export const governanceLiveKey = (workspaceId: string) => unstable_serialize(governanceKey(workspaceId))

/**
 * Re-reads a mounted plan / seat / role summary after a member action
 * (suspend, restore, role change, invite, revoke) changed what it counts.
 * Nothing is fetched when no summary for that workspace is mounted or cached.
 */
export function useRevalidateGovernance() {
  const { mutate } = useSWRConfig()
  return useCallback((workspaceId: string) => mutate(governanceKey(workspaceId)), [mutate])
}

/** The workspace's governance summary; templates come back only to admins whose plan has them. */
export function useGovernanceSummary(workspaceId: string | undefined) {
  return useSWR(workspaceId ? governanceKey(workspaceId) : null, ([, id]) => request<GovernanceSummary>(base(id)), { shouldRetryOnError: false, revalidateOnFocus: false })
}

/** Save (create or update), apply and delete. Each re-reads the summary; none is optimistic. */
export function useGovernanceTemplates(workspaceId: string) {
  const summary = useGovernanceSummary(workspaceId)
  const [pending, setPending] = useState<string | null>(null)
  async function run<T>(key: string, body: unknown) {
    setPending(key)
    try {
      const result = await request<T>(base(workspaceId), { method: 'POST', body: JSON.stringify(body) })
      await summary.mutate()
      return result
    } finally { setPending(null) }
  }
  return {
    pending,
    save: (template: { id?: string; name: string; rules: GovernanceRules }) => run<{ id: string }>(`save:${template.id ?? 'new'}`, { action: 'save', template }),
    apply: (templateId: string) => run<{ applied: true }>(`apply:${templateId}`, { action: 'apply', templateId }),
    remove: (templateId: string) => run<{ deleted: true }>(`delete:${templateId}`, { action: 'delete', templateId }),
  }
}

const day = (date: Date) => date.toISOString().slice(0, 10)
/** The report's default range: the last 30 UTC days, both ends included (the server's default). */
export function defaultUsageRange(now = new Date()) {
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const from = new Date(to); from.setUTCDate(from.getUTCDate() - 29)
  return { from: day(from), to: day(to) }
}
/** Longest range the server accepts, in days. */
export const USAGE_MAX_DAYS = 93

/** Team usage for a UTC date range; null `range` reads nothing (no entitlement or no admin). */
export function useGovernanceUsage(workspaceId: string, range: { from: string; to: string } | null) {
  return useSWR(range ? ['governance-usage', workspaceId, range.from, range.to] : null, ([, id, from, to]) => request<GovernanceUsage>(`${base(id)}/usage?${new URLSearchParams({ from, to })}`), { shouldRetryOnError: false, revalidateOnFocus: false, keepPreviousData: true })
}

/** The CSV download for the same range; the server checks role and plan again before answering. */
export function governanceUsageCsvHref(workspaceId: string, range: { from: string; to: string }) {
  return withBasePath(`${base(workspaceId)}/usage?${new URLSearchParams({ ...range, format: 'csv' })}`)
}
