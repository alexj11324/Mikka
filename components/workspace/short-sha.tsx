'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { GitCommitHorizontal } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export const shortSha = (sha: string) => sha.slice(0, 7)

/** A commit as GitHub shows it: 7 characters; hover shows the full sha, click copies it. */
export function ShortSha({ sha, tone, icon = false, children }: { sha: string; tone?: 'neutral'; icon?: boolean; children?: (short: string) => ReactNode }) {
  const t = useTranslations('FactoryAcceptance')
  const short = shortSha(sha)
  const copy = async () => {
    try { await navigator.clipboard.writeText(sha); toast.success(t('shaCopied')) } catch { toast.error(t('shaCopyFailed')) }
  }
  return <Tooltip>
    <TooltipTrigger render={<Button variant="ghost" size="xs" className={cn(icon && 'px-0')} aria-label={t('copySha', { sha })} data-sha={sha} onClick={() => { void copy() }} />}>
      <Badge variant="outline" tone={tone}>{icon && <GitCommitHorizontal aria-hidden="true" />}<span className="font-mono">{children ? children(short) : short}</span></Badge>
    </TooltipTrigger>
    <TooltipContent><span className="font-mono">{sha}</span></TooltipContent>
  </Tooltip>
}
