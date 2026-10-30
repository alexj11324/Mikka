'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export const shortSha = (sha: string) => sha.slice(0, 7)

/** A commit as GitHub shows it: 7 characters; hover shows the full sha, click copies it. */
export function ShortSha({ sha, tone, children }: { sha: string; tone?: 'neutral'; children?: (short: string) => ReactNode }) {
  const t = useTranslations('FactoryAcceptance')
  const short = shortSha(sha)
  const copy = async () => {
    try { await navigator.clipboard.writeText(sha); toast.success(t('shaCopied')) } catch { toast.error(t('shaCopyFailed')) }
  }
  return <Tooltip>
    <TooltipTrigger render={<Badge variant="outline" tone={tone} render={<button type="button" aria-label={t('copySha', { sha })} data-sha={sha} onClick={() => { void copy() }} />} />}>
      <span className="font-mono">{children ? children(short) : short}</span>
    </TooltipTrigger>
    <TooltipContent><span className="font-mono">{sha}</span></TooltipContent>
  </Tooltip>
}
