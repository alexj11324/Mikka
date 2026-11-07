'use client'

import { useTranslations } from 'next-intl'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { useLocaleSwitch, type AppLocale } from '@/hooks/settings/use-preferences-page'

/** D14: switching the interface language. The choice is remembered in NEXT_LOCALE. */
export function LocaleSetting() {
  const t = useTranslations('Settings.appearance')
  const { locale, switchTo } = useLocaleSwitch()
  return <ToggleGroup aria-label={t('language')} variant="segment" spacing={0.5} value={[locale]} onValueChange={values => switchTo(values[0] as AppLocale | undefined)}>
    <ToggleGroupItem value="zh-CN" aria-label={t('languageZh')}>{t('languageZh')}</ToggleGroupItem>
    <ToggleGroupItem value="en" aria-label={t('languageEn')}>{t('languageEn')}</ToggleGroupItem>
  </ToggleGroup>
}
