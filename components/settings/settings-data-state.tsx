'use client'

import { SettingsContent } from '@/components/ui/settings-layout'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'

export function SettingsDataState({ title, error, onRetry }: { title: string; error?: Error; onRetry: () => void }) {
  return <SettingsContent aria-busy={!error} data-settings-state={error ? 'error' : 'loading'}>
    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    {error ? <Alert variant="destructive"><AlertTitle>暂时无法读取{title}</AlertTitle><AlertDescription><p>{error.message}</p><Button variant="outline" size="sm" onClick={onRetry}>重新读取</Button></AlertDescription></Alert> : <div role="status" aria-label={`正在读取${title}`} className="flex flex-col gap-4"><span className="sr-only">正在读取{title}…</span><Skeleton className="h-5 w-64 max-w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /></div>}
  </SettingsContent>
}
