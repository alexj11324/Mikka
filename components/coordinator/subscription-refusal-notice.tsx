'use client'

import type { ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { Alert, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Link } from '@/i18n/navigation'
import { settingsHref } from '@/lib/settings-sections'
import { COMPOSER_NOTICE } from './composer-notice'
import { subscriptionRecovery, type SubscriptionRefusalNotice as Notice } from '@/lib/subscription-refusal'
import { openModelPicker } from './bot-model-picker'

/**
 * The chosen subscription refused a turn: one line above the composer in place
 * of 回复失败, the same for the Coordinator and every bot, with the way on in
 * 设置 › 模型与订阅, model selection, or retry, according to the cause.
 */
export function SubscriptionRefusalNotice({ notice, retry, botId }: { notice: Notice; retry?: ReactNode; botId: string | null }) {
  const t = useTranslations('Coordinator.subscriptionRefusal')
  const picker = useTranslations('Coordinator.modelPicker')
  const recovery = subscriptionRecovery(notice)
  return <Alert data-subscription-refusal={notice} role="status" className={COMPOSER_NOTICE}>
    <Info aria-hidden="true" className="shrink-0" />
    <AlertTitle className="min-w-0 flex-1 basis-48">{t(notice)}</AlertTitle>
    <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1">
      {recovery === 'retry' && retry}
      {recovery === 'settings' && <Button size="sm" nativeButton={false} role="link" render={<Link href={settingsHref('models')} />}>{t('open')}</Button>}
      {recovery === 'model' && <Button size="sm" onClick={() => openModelPicker(botId)}>{picker('changeModel')}</Button>}
    </span>
  </Alert>
}
