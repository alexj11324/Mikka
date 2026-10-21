'use client'

import useSWR from 'swr'
import { useState } from 'react'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { WorkspaceSettings } from '@/lib/workspace-access'
import { MembersSettings } from '@/components/workspace/members-settings'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'

async function fetchMembers([url]: readonly [string, string]): Promise<WorkspaceSettings> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('无法读取成员，请确认工作区访问权限后重试。')
  return response.json()
}

export function MembersPanel({ userKey, workspaceId, inviteInitially = false }: { userKey: string; workspaceId?: string; inviteInitially?: boolean }) {
  const [selectedId, setSelectedId] = useState(workspaceId)
  const url = selectedId ? `/api/workspace?workspace=${encodeURIComponent(selectedId)}` : '/api/workspace'
  const { data, error, mutate } = useSWR([url, userKey] as const, fetchMembers, { dedupingInterval: 15000, revalidateOnFocus: true })
  if (!data && error) return <div role="alert" className="flex flex-col items-start gap-4"><p className="text-sm text-destructive">{error.message}</p><Button variant="outline" onClick={() => void mutate()}>重试</Button>{selectedId && <Button variant="ghost" onClick={() => setSelectedId(undefined)}>返回可访问的工作区</Button>}</div>
  if (!data) return <div role="status" aria-label="正在加载成员" className="flex flex-col gap-6"><Skeleton className="h-11 w-full" /><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /><span className="sr-only">正在加载成员</span></div>
  return <div className="flex min-w-0 flex-col gap-6"><Select value={data.workspace.id} items={data.choices.map(item => ({ value: item.id, label: item.name }))} onValueChange={value => { if (value) setSelectedId(value) }}><SelectTrigger aria-label="当前工作区" className="min-h-11 w-full sm:w-64"><SelectValue /></SelectTrigger><SelectContent><SelectGroup>{data.choices.map(item => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectGroup></SelectContent></Select><MembersSettings key={data.workspace.id} data={data} fetchError={error} mutate={mutate} inviteInitially={inviteInitially} /></div>
}
