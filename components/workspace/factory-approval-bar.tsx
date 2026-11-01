'use client'

import { useTranslations } from 'next-intl'
import { Ban, Check, CircleCheck, CircleX, Clock, ExternalLink, GitMerge, RefreshCw, Server, TriangleAlert, Upload, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Item, ItemActions, ItemContent, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Spinner } from '@/components/ui/spinner'
import { ShortSha } from './short-sha'
import { PullRequestIcon } from './pull-request-icon'
import { acceptanceStateKey, type AcceptanceState } from '@/lib/factory/acceptance-state'

export type ApprovalBarProps = {
  state: AcceptanceState
  isSkill: boolean
  /** Where it ships, as Figma's chip names it (Preview / Production / 内置技能). */
  environment?: string
  /** The candidate's full sha, shown short (hover for full, click to copy). */
  sha?: string
  busy?: boolean
  canApprove?: boolean
  /** Publishing needs a complete environment; without one 发布 is hidden, not disabled. */
  canPublish?: boolean
  reference?: { href: string; label: string }
  /** Full sha of an approval voided by a newer commit, shown as 「<short sha> · 已失效」. */
  superseded?: string
  onApprove?: () => void
  onPublish?: () => void
  onRevoke?: () => void
  onReconcile?: () => void
  /** Only passed when the server can take a send-back; otherwise the action is hidden. */
  onReject?: () => void
  /** A code candidate (#528): its one action merges the PR as this person (验收并合并). */
  onAccept?: () => void
  /** The candidate's PR, opened from the merged and refused states. */
  pullRequestUrl?: string
  /** GitHub refused the last merge (a githubMerge… code): the bar names why and offers the PR. */
  refusal?: string
}

function StateIcon({ state, refused }: { state: AcceptanceState; refused: boolean }) {
  if (state === 'pending' && refused) return <TriangleAlert aria-hidden="true" className="text-warning" />
  if (state === 'publishing' || state === 'checking' || state === 'merging') return <Spinner />
  // A merged PR reads as GitHub draws it, the same mark as the candidate card's PR.
  if (state === 'merged') return <PullRequestIcon state="merged" />
  if (state === 'approved' || state === 'live') return <CircleCheck aria-hidden="true" />
  if (state === 'failed') return <CircleX aria-hidden="true" />
  if (state === 'expired') return <Clock aria-hidden="true" />
  if (state === 'revoked' || state === 'invalidated' || state === 'unavailable') return <Ban aria-hidden="true" />
  return null
}

/** A busy action swaps its icon for the Spinner, so the button keeps its width (no layout jump). */
function ActionIcon({ icon: Icon, busy }: { icon: LucideIcon; busy: boolean }) {
  return busy ? <Spinner data-icon="inline-start" /> : <Icon data-icon="inline-start" aria-hidden="true" />
}

/**
 * The publication decision for one candidate (Figma 358:6855), pinned under
 * the 验收 tab: environment and commit on the left, the actions on
 * the right. While it waits for you the header's state chip says so, so the
 * bar carries no title; every later state names itself. Purely presentational.
 */
export function ApprovalBar({ state, isSkill, environment, sha, busy = false, canApprove = true, canPublish = true, reference, superseded, onApprove, onPublish, onRevoke, onReconcile, onReject, onAccept, pullRequestUrl, refusal }: ApprovalBarProps) {
  const t = useTranslations('FactoryAcceptance')
  const refused = state === 'pending' && Boolean(refusal)
  const icon = StateIcon({ state, refused })
  // After GitHub refuses, the fix is usually on GitHub, so opening the PR leads and merging again follows.
  const openPullRequest = pullRequestUrl && <Button size="sm" variant={refused ? 'default' : 'secondary'} render={<a href={pullRequestUrl} target="_blank" rel="noopener noreferrer" />}><ExternalLink data-icon="inline-start" aria-hidden="true" />{t('openOnGitHub')}</Button>
  return <Item variant="muted" data-state={state}>
    {icon && <ItemMedia variant="icon">{icon}</ItemMedia>}
    <ItemContent>
      {(state !== 'pending' || refused) && <ItemTitle>{refused ? t('cannotMerge') : t(acceptanceStateKey(state, isSkill))}</ItemTitle>}
      {(sha || superseded || environment || refused) && <div className="flex flex-wrap items-center gap-1">
        {refused && <Badge variant="outline" tone="warning">{t(`mergeRefusal.${refusal}` as 'mergeRefusal.githubUnavailable')}</Badge>}
        {environment && <Badge variant="outline"><Server aria-hidden="true" />{environment}</Badge>}
        {sha && <ShortSha sha={sha} />}
        {superseded && <ShortSha sha={superseded} tone="neutral">{short => t('superseded', { sha: short })}</ShortSha>}
      </div>}
    </ItemContent>
    <ItemActions>
      {state === 'pending' && !refused && onReject && <Button size="sm" variant="secondary" disabled={busy} onClick={onReject}>{t('reject')}</Button>}
      {state === 'pending' && canApprove && (onAccept
        ? <Button size="sm" variant={refused && pullRequestUrl ? 'secondary' : 'default'} disabled={busy} aria-busy={busy} onClick={onAccept}><ActionIcon icon={GitMerge} busy={busy} />{t('accept')}</Button>
        : <Button size="sm" disabled={busy} aria-busy={busy} onClick={onApprove}><ActionIcon icon={Check} busy={busy} />{t('enable')}</Button>)}
      {(state === 'merged' || refused) && openPullRequest}
      {state === 'approved' && <>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onRevoke}>{t('revoke')}</Button>
        {canPublish && <Button size="sm" disabled={busy} aria-busy={busy} onClick={onPublish}><ActionIcon icon={Upload} busy={busy} />{t('publish')}</Button>}
      </>}
      {state === 'failed' && <>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onRevoke}>{t('revoke')}</Button>
        {canPublish && <Button size="sm" disabled={busy} aria-busy={busy} onClick={onPublish}><ActionIcon icon={Upload} busy={busy} />{t('publish')}</Button>}
      </>}
      {(state === 'publishing' || state === 'checking') && <>
        <Button size="sm" variant="secondary" disabled={busy} onClick={onRevoke}>{t('revoke')}</Button>
        <Button size="sm" disabled={busy} aria-busy={busy} onClick={onReconcile}><ActionIcon icon={RefreshCw} busy={busy} />{t('reconcile')}</Button>
      </>}
      {state === 'live' && reference && <Button size="sm" variant="outline" render={<a href={reference.href} target="_blank" rel="noopener noreferrer" />}><ExternalLink data-icon="inline-end" />{reference.label}</Button>}
    </ItemActions>
  </Item>
}
