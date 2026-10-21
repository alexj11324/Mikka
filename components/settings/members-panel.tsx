'use client'

import { useWorkspace } from '@/hooks/use-workspace'
import { MembersSettings } from '@/components/workspace/members-settings'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'

export function MembersPanel({ userKey, workspaceId, inviteInitially = false }: { userKey: string; workspaceId?: string; inviteInitially?: boolean }) {
  const { data, error, mutate } = useWorkspace(userKey, workspaceId)
  if (!data && error) return <div role="alert" className="flex flex-col items-start gap-4"><p className="text-sm text-destructive">{error.message}</p><Button variant="outline" onClick={() => void mutate()}>重试</Button></div>
  if (!data) return <div role="status" aria-label="正在加载成员" className="flex flex-col gap-6"><Skeleton className="h-11 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><span className="sr-only">正在加载成员</span></div>
  return <MembersSettings key={data.workspace.id} data={data} fetchError={error} mutate={mutate} inviteInitially={inviteInitially} />
}
