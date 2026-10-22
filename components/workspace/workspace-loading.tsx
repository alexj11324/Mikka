import { useTranslations } from 'next-intl'
import { Skeleton } from '@/components/ui/skeleton'

export function WorkspaceContentLoading() {
  const t = useTranslations('Workspace')
  return <div role="status" aria-label={t('loadingEditor')} aria-busy="true" className="flex min-h-0 flex-1 flex-col gap-6 p-4 sm:p-6">
    <span className="sr-only">{t('loadingEditor')}</span>
    <div aria-hidden="true" className="flex flex-1 flex-col gap-6">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-20 w-2/3" />
      <Skeleton className="h-32 w-full" />
    </div>
  </div>
}

export function WorkspaceLoading() {
  return <div className="flex min-h-dvh bg-background text-foreground">
    <aside aria-hidden="true" className="hidden w-64 shrink-0 flex-col gap-6 border-r bg-sidebar p-4 md:flex">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-8 w-full" />
      <div className="flex flex-col gap-3">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-8 w-full" />)}</div>
      <Skeleton className="mt-auto h-10 w-full" />
    </aside>
    <main className="flex min-w-0 flex-1 flex-col">
      <div aria-hidden="true" className="flex h-12 shrink-0 items-center gap-3 px-4"><Skeleton className="size-6" /><Skeleton className="h-4 w-32" /></div>
      <WorkspaceContentLoading />
    </main>
  </div>
}
