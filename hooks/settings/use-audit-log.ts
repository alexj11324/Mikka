'use client'

import { useState } from 'react'
import useSWRInfinite from 'swr/infinite'
import { useLocale, useTranslations } from 'next-intl'
import type { listAuditLog } from '@/app/actions/audit-log'
import type { AuditFilter, AuditScope } from '@/lib/audit/cursor'
import type { AuditCategory } from '@/lib/audit/categories'
import type { AuditEventView } from '@/lib/audit/query'
import { withBasePath } from '@/lib/base-path'
import { dayLabel } from '@/lib/relative-time'
import { settingsRead } from '@/lib/settings-read'
import { settingsKeys } from '@/lib/swr/keys'
import { useActionError } from '@/lib/use-action-error'
import { auditReadFailure } from '@/lib/audit/read-failure'

type Page = Awaited<ReturnType<typeof listAuditLog>>

/** 审计日志's period: ISO instants, `from` inclusive and `until` exclusive; null is the whole 90 days. */
export type AuditRange = { from: string; until: string } | null

/** Scalar metadata only: the ICU templates take named string params. Roles and access levels are words, not codes. */
function params(event: AuditEventView, word: (key: string) => string | null) {
  const values: Record<string, string> = { target: event.targetLabel ?? '' }
  for (const [key, value] of Object.entries(event.metadata ?? {})) if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') values[key] = String(value)
  if (event.action === 'member.role_changed' && values.newRole) values.newRole = word(`roles.${values.newRole}`) ?? values.newRole
  if (event.action === 'integration.permission_changed' && values.to) values.to = word(`access.${values.to}`) ?? values.to
  if (event.action === 'integration.permission_changed' && values.integration) values.integration = word(`apps.${values.integration}`) ?? values.integration
  return values
}

/**
 * 设置 › 审计日志's reads and state (N6: admins only, the last 90 days, newest
 * first): the 全部 / 安全 filter, the categories and period a layer may narrow
 * to, the pages, the day groups, the words for each event and the CSV export's
 * address for what is shown. The open-source page uses 全部 / 安全 only.
 */
export function useAuditLog(workspaceId: string) {
  const t = useTranslations('Settings.audit')
  const locale = useLocale()
  const actionError = useActionError()
  const [filter, setFilter] = useState<AuditFilter>('all')
  const [categories, setCategories] = useState<AuditCategory[] | undefined>(undefined)
  const [range, setRange] = useState<AuditRange>(null)
  const scope: Partial<AuditScope> = { filter, categories: categories?.length ? categories : undefined, from: range?.from, until: range?.until }
  const scopeKey = JSON.stringify([scope.categories ?? null, scope.from ?? null, scope.until ?? null])
  const pages = useSWRInfinite(
    (index, previous: Page | null) => {
      if (previous && (previous.error || !previous.nextCursor)) return null
      const cursor = index === 0 ? null : previous && !previous.error ? previous.nextCursor : null
      // The 全部 / 安全 read keeps the key it always had (settings-prefetch warms it).
      return scopeKey === '[null,null,null]' ? settingsKeys.audit(workspaceId, filter, cursor) : [...settingsKeys.audit(workspaceId, filter, cursor), scopeKey] as const
    },
    ([, id, segment, cursor, narrowed]: readonly [string, string, string, string | null, string?]) => {
      const [category, from, until] = narrowed ? JSON.parse(narrowed) as [string[] | null, string | null, string | null] : [null, null, null]
      return settingsRead<Page>('audit', { workspace: id, filter: segment, cursor, category: category?.join(','), from, until })
    },
    { revalidateFirstPage: false },
  )
  const failure = pages.data?.find(page => page.error)
  const readFailed = Boolean(pages.error || failure)
  const events = readFailed ? [] : (pages.data ?? []).flatMap(page => page.error ? [] : page.events)
  const last = pages.data?.at(-1)
  const more = !readFailed && Boolean(last && !last.error && last.nextCursor)
  const time = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' })
  const days: Array<[string, AuditEventView[]]> = []
  for (const event of events) {
    const label = dayLabel(event.createdAt, locale)
    if (days.at(-1)?.[0] === label) days.at(-1)![1].push(event)
    else days.push([label, [event]])
  }
  const search = new URLSearchParams({ filter })
  if (scope.categories) search.set('category', scope.categories.join(','))
  if (scope.from) search.set('from', scope.from)
  if (scope.until) search.set('until', scope.until)
  const exportHref = withBasePath(`/api/workspaces/${encodeURIComponent(workspaceId)}/audit-log?${search}`)

  const word = (path: string) => t.has(path as never) ? t(path as never) : null
  /** The event as a sentence. An argument the event did not record reads as nothing; an action without words is still a readable line, never a code or a key path. */
  function sentence(event: AuditEventView) {
    const key = `actions.${event.action}`
    const unknown = () => t('unknownAction', { action: event.action.replace(/[._]+/g, ' ').trim() })
    const raw = t.has(key as never) ? t.raw(key as never) : null
    if (typeof raw !== 'string') return unknown()
    const values = params(event, word)
    for (const [, name] of raw.matchAll(/\{\s*(\w+)/g)) values[name] ??= ''
    const text = t(key as never, values as never)
    return text.includes(`audit.${key}`) ? unknown() : text
  }

  // A refused read says why: an admin-only page for a member, a sign-in, or the code to quote.
  const refused = pages.error ? auditReadFailure(pages.error) : null
  const error = failure ? actionError(failure.error) : refused ? refused.kind === 'adminOnly' ? t('adminOnly') : actionError(refused.kind === 'signedOut' ? 'authRequired' : undefined) : null
  const errorCode = failure?.error ?? refused?.code ?? null
  const retry = readFailed && !['authRequired', 'workspaceAccessDenied', 'workspaceMembershipSuspended'].includes(errorCode ?? '')
    ? () => pages.mutate()
    : undefined
  const loading = pages.isLoading
  const empty = !loading && !error && events.length === 0
  return {
    filter, setFilter, categories: scope.categories, setCategories, range, setRange,
    events, days, time: (event: AuditEventView) => time.format(new Date(event.createdAt)), sentence,
    category: (event: AuditEventView) => t(`categories.${event.category}`),
    actorType: (event: AuditEventView) => event.actorType === 'bot' || event.actorType === 'token' ? t(`actorTypes.${event.actorType}`) : null,
    loading, error, errorCode, empty, retry,
    more, loadingMore: pages.isValidating && !loading, loadMore: () => void pages.setSize(pages.size + 1),
    exportHref,
  }
}

export type AuditLogState = ReturnType<typeof useAuditLog>
