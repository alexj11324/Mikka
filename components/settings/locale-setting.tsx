'use client'

import { useLocale, useTranslations } from 'next-intl'
import { usePathname, useRouter } from '@/i18n/navigation'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'

/** D14: switching the interface language. The choice is remembered in NEXT_LOCALE. */
export function LocaleSetting() {
  const t = useTranslations('Settings.appearance')
  const locale = useLocale() as 'zh-CN' | 'en'
  const pathname = usePathname()
  const router = useRouter()
  return <ToggleGroup aria-label={t('language')} variant="outline" spacing={0} value={[locale]} onValueChange={values => {
    const next = values[0] as 'zh-CN' | 'en' | undefined
    if (!next || next === locale) return
    router.replace(pathname, { locale: next })
    router.refresh()
  }}>
    <ToggleGroupItem value="zh-CN" aria-label={t('languageZh')}>{t('languageZh')}</ToggleGroupItem>
    <ToggleGroupItem value="en" aria-label={t('languageEn')}>{t('languageEn')}</ToggleGroupItem>
  </ToggleGroup>
}
