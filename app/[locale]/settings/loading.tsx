import { getTranslations } from 'next-intl/server'
import { SettingsContent } from '@/components/ui/settings-layout'
import { Skeleton } from '@/components/ui/skeleton'

// The words a screen reader hears follow the page's language (review C12, R-42).
export default async function SettingsLoading() {
  const t = await getTranslations('Settings')
  return <SettingsContent role="status" aria-label={t('loadingPage')} aria-busy="true">
    <span className="sr-only">{t('loadingPage')}</span>
    <div aria-hidden="true" className="flex flex-col gap-3">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-4 w-64 max-w-full" />
    </div>
    <div aria-hidden="true" className="flex flex-col gap-4">
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-full" />
    </div>
  </SettingsContent>
}
