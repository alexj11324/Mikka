import { SettingsContent } from '@/components/ui/settings-layout'
import { Skeleton } from '@/components/ui/skeleton'

export default function SettingsLoading() {
  return <SettingsContent role="status" aria-label="正在加载设置" aria-busy="true">
    <span className="sr-only">正在加载设置…</span>
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
