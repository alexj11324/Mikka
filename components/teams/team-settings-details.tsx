'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Settings, Users } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Team = { id: string; workspaceId: string; name: string; identifier: string; description: string; memberCount: number }

export function TeamSettingsDetails({ team }: { team: Team }) {
  const href = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
  return <section className="flex flex-col gap-8" aria-label={`${team.name} 团队设置`}>
    <Link className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')} href={`/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}`}><ChevronLeft data-icon="inline-start" />全部团队</Link>
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 pb-12 sm:pt-4">
      <header className="flex flex-wrap items-end justify-between gap-4 px-1 sm:px-4"><div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1><p className="text-sm text-muted-foreground">所有工作区成员均可访问</p></div><Link className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={`/?team=${encodeURIComponent(team.id)}`}>团队概览<ChevronRight data-icon="inline-end" /></Link></header>
      <section className="flex flex-col rounded-xl border bg-card px-4 sm:px-5" aria-label="团队设置选项">
        <Link href={`${href}&view=general`} className="flex min-w-0 items-center gap-3 rounded-lg py-5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Settings className="size-5" aria-hidden="true" /></span><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="text-sm font-medium">常规设置</span><span className="text-sm text-muted-foreground">名称、团队标识与简介</span></span><ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></Link>
        <Link href={`${href}&view=members`} className="flex min-w-0 items-center gap-3 rounded-lg py-5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"><span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><Users className="size-5" aria-hidden="true" /></span><span className="flex min-w-0 flex-1 flex-col gap-1"><span className="text-sm font-medium">成员</span><span className="text-sm text-muted-foreground">管理团队成员</span></span><span className="shrink-0 text-sm text-muted-foreground">{team.memberCount} 位成员</span><ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" /></Link>
      </section>
    </div>
  </section>
}
