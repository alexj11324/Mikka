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

/** The first paint: the same window frame as the app (window bar, rail, one card) so nothing jumps when it arrives. */
export function WorkspaceLoading() {
  return <div className="flex h-svh flex-col overflow-hidden bg-shell-chrome text-foreground in-data-desktop-translucent:bg-transparent">
    <div aria-hidden="true" className="hidden h-11 shrink-0 grid-cols-[1fr_minmax(0,26rem)_1fr] items-center gap-3 pr-2 pl-3 md:grid"><span /><Skeleton className="h-7 w-full rounded-full" /><span /></div>
    <div className="flex min-h-0 flex-1 md:pr-2 md:pb-2">
      <div aria-hidden="true" className="hidden w-17 shrink-0 flex-col items-center gap-1 pt-1 md:flex">{Array.from({ length: 3 }, (_, index) => <Skeleton key={index} className="size-9 rounded-lg" />)}</div>
      <div className="flex min-w-0 flex-1 overflow-hidden bg-background in-data-desktop-translucent:bg-transparent md:rounded-xl md:shadow-xs md:ring-1 md:ring-border">
        <aside aria-hidden="true" className="hidden w-64 shrink-0 flex-col gap-3 border-r p-3 md:flex">
          <Skeleton className="h-8 w-24" />
          {Array.from({ length: 5 }, (_, index) => <Skeleton key={index} className="h-12 w-full rounded-xl" />)}
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-background"><WorkspaceContentLoading /></main>
      </div>
    </div>
  </div>
}
