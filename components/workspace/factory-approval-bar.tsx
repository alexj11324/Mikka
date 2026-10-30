'use client'

import { useTranslations } from 'next-intl'
import { Ban, CircleCheck, CircleX, Clock, ExternalLink } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { acceptanceStateKey, type AcceptanceState } from '@/lib/factory/acceptance-state'

export type ApprovalBarProps = {
  state: AcceptanceState
  isSkill: boolean
  details: string[]
  busy?: boolean
  canApprove?: boolean
  reference?: { href: string; label: string }
  onApprove?: () => void
  onPublish?: () => void
  onRevoke?: () => void
  onReconcile?: () => void
}

function StateIcon({ state }: { state: AcceptanceState }) {
  if (state === 'publishing' || state === 'checking') return <Spinner />
  if (state === 'approved' || state === 'live') return <CircleCheck aria-hidden="true" />
  if (state === 'failed') return <CircleX aria-hidden="true" />
  if (state === 'expired') return <Clock aria-hidden="true" />
  if (state === 'revoked' || state === 'invalidated' || state === 'unavailable') return <Ban aria-hidden="true" />
  return null
}

/** The publication decision for one candidate (Figma 358:6855). Purely presentational. */
export function ApprovalBar({ state, isSkill, details, busy = false, canApprove = true, reference, onApprove, onPublish, onRevoke, onReconcile }: ApprovalBarProps) {
  const t = useTranslations('FactoryAcceptance')
  const icon = StateIcon({ state })
  return <Item variant="muted" data-state={state}>
    {icon && <ItemMedia variant="icon">{icon}</ItemMedia>}
    <ItemContent>
      <ItemTitle>{t(acceptanceStateKey(state, isSkill))}</ItemTitle>
      {details.length > 0 && <div className="flex flex-wrap gap-1">{details.map(detail => <Badge key={detail} variant="outline">{detail}</Badge>)}</div>}
    </ItemContent>
    <ItemActions>
      {state === 'pending' && <Button size="sm" disabled={busy || !canApprove} onClick={onApprove}>{isSkill ? t('enable') : t('approve')}</Button>}
      {state === 'approved' && <>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRevoke}>{t('revoke')}</Button>
        <Button size="sm" disabled={busy} onClick={onPublish}>{t('publish')}</Button>
      </>}
      {(state === 'publishing' || state === 'checking' || state === 'failed') && <>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onRevoke}>{t('revoke')}</Button>
        <Button size="sm" disabled={busy} onClick={onReconcile}>{t('reconcile')}</Button>
      </>}
      {state === 'live' && reference && <Button size="sm" variant="outline" render={<a href={reference.href} target="_blank" rel="noopener noreferrer" />}><ExternalLink data-icon="inline-end" />{reference.label}</Button>}
    </ItemActions>
  </Item>
}
