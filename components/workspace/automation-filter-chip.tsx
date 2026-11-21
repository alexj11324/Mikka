'use client'

import useSWR from 'swr'
import { useTranslations } from '@/lib/intl/i18n-client'
import { getAutomation } from '@/app/actions/automations'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { X } from '@/components/icons'

/** 自动化为 <名称>: the thread directory's automation filter (查看运行), with ✕ to drop it. */
export function AutomationFilterChip({ automationId, workspaceId, onClear }: { automationId: string; workspaceId: string | null; onClear?: () => void }) {
  const t = useTranslations('ConversationDirectory')
  // The name is read once; a rename shows on the next visit (the chip names the filter, it does not follow the automation).
  const { data } = useSWR(workspaceId ? ['automation-filter-name', workspaceId, automationId] as const : null, async ([, workspace, id]) => {
    const result = await getAutomation(id, workspace)
    return 'automation' in result ? result.automation?.definition.title ?? null : null
  }, { revalidateOnFocus: false, shouldRetryOnError: false })
  // control-size-exempt: the clear button sits inside a badge chip, sized to the chip.
  return <Badge variant="secondary" className="gap-1">
    {t('automationFilter', { name: data ?? t('automationUnknown') })}
    {onClear && <Button size="icon-xs" variant="ghost" aria-label={t('clearAutomation')} onClick={onClear}><X /></Button>}
  </Badge>
}
