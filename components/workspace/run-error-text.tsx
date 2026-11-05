'use client'

import { useTranslations } from 'next-intl'
import { runErrorCopy } from '@/lib/run-error-view'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'

/**
 * A run's stored failure as a person reads it: the copy for a known code, else the
 * text as it is. `code` is the raw code, for the details area only (decision 2026-11-05-0330).
 */
export function useRunErrorText() {
  const t = useTranslations()
  return (text: string | null): { message: string | null; code: string | null } => {
    const copy = runErrorCopy(text)
    return copy ? { message: t(`${copy.namespace}.${copy.key}` as never), code: copy.code } : { message: text, code: null }
  }
}

/** 详情 under a failure line: the raw code, folded. */
export function RunErrorDetails({ code }: { code: string }) {
  const t = useTranslations('IssueThreads')
  return <Collapsible data-slot="run-error-details">
    <CollapsibleTrigger render={<Button variant="link" size="xs" className="h-auto px-0 py-0.5 text-xs text-muted-foreground" />}>{t('errorDetails')}</CollapsibleTrigger>
    <CollapsibleContent><code className="block text-xs break-all text-muted-foreground">{code}</code></CollapsibleContent>
  </Collapsible>
}
