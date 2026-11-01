'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { COMPOSER_NOTICE } from './composer-notice'
import type { SubscriptionRefusalNotice as Notice } from '@/lib/subscription-refusal'

/**
 * The chosen subscription refused a turn: one line above the composer in place
 * of 回复失败, the same for the Coordinator and every bot, with the way on in
 * 设置 › 模型与额度 unless it is only a moment's outage.
 */
export function SubscriptionRefusalNotice({ notice, retry }: { notice: Notice; retry?: ReactNode }) {
  const t = useTranslations('Coordinator.subscriptionRefusal')
  return <Alert data-subscription-refusal={notice} role="status" className={COMPOSER_NOTICE}>
    <Info aria-hidden="true" className="shrink-0" />
    <AlertTitle className="min-w-0 flex-1 basis-48">{t(notice)}</AlertTitle>
    <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
      {retry}
      {notice !== 'retry' && <Button size="sm" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{t('open')}</Button>}
    </span>
  </Alert>
}
