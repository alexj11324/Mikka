'use client'
import { useTranslations } from 'next-intl'

import { SettingsContent } from '@/components/ui/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function SettingsDataState({ title, error, onRetry }: { title: string; error?: Error; onRetry: () => void }) {
  const i18nText = useTranslations();
  return <SettingsContent aria-busy={!error} data-settings-state={error ? 'error' : 'loading'}>
    <h1 className="text-xl font-semibold">{title}</h1>
    {error ? <Alert variant="destructive"><AlertTitle>{i18nText("FeatureCopy.c_4c0521ff")}{title}</AlertTitle><AlertDescription><p>{error.message}</p><Button variant="outline" size="sm" onClick={onRetry}>{i18nText("Projects.reload")}</Button></AlertDescription></Alert> : <div role="status" aria-label={i18nText("FeatureCopy.c_494c8a54", { value0: (title) })} data-loading-placeholder="" className="flex flex-col gap-4"><span className="sr-only">{i18nText("FeatureCopy.c_62e51561")}{title}…</span><Skeleton className="h-5 w-64 max-w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>}
  </SettingsContent>
}
