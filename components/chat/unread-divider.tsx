'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { UNREAD_DIVIDER_ATTR } from '@/lib/hooks/use-unread-indicators'

/** MIK-8 「新」 divider. The only file exempt from style/no-horizontal-rule. */
export function UnreadDivider() {
  const t = useTranslations('Unread')
  return <div role="separator" aria-label={t('divider')} {...{ [UNREAD_DIVIDER_ATTR]: '' }} className="flex items-center gap-2">
    <Separator className="flex-1" />
    <Badge>{t('newLabel')}</Badge>
    <Separator className="flex-1" />
  </div>
}
