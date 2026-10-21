'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

type Team = { id: string; workspaceId: string; name: string; identifier: string; description: string; memberCount: number }

export function TeamSettingsDetails({ team }: { team: Team }) {
  const href = `/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}&team=${encodeURIComponent(team.id)}`
  return <section className="flex flex-col gap-12" aria-label={`${team.name} 团队设置`}>
    <Link aria-label="全部团队" className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')} href={`/settings/teams?workspace=${encodeURIComponent(team.workspaceId)}`}><ChevronLeft data-icon="inline-start" /><span lang="en">All teams</span></Link>
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-9 pb-12 sm:pt-1">
      <header className="flex flex-wrap items-end justify-between gap-4 px-1 sm:px-4"><h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1><Link aria-label="团队概览" className={buttonVariants({ variant: 'ghost', size: 'sm' })} href={`/?team=${encodeURIComponent(team.id)}`}><span lang="en">Team overview</span><ChevronRight data-icon="inline-end" /></Link></header>
      <section className="flex flex-col rounded-xl border bg-card px-5" aria-label="团队设置选项">
        <Link aria-label="常规设置" href={`${href}&view=general`} className="flex min-h-20 min-w-0 items-center justify-between gap-5 rounded-lg py-5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"><span className="text-sm" lang="en">General</span><span className="flex min-w-0 items-center gap-2 text-sm text-muted-foreground"><span className="truncate" lang="en">Name, identifier, icon and more</span><ChevronRight className="size-4 shrink-0" aria-hidden="true" /></span></Link>
        <Link aria-label="成员" href={`${href}&view=members`} className="flex min-h-20 min-w-0 items-center justify-between gap-5 rounded-lg py-5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"><span className="text-sm" lang="en">Members</span><span className="flex shrink-0 items-center gap-2 text-sm text-muted-foreground"><span aria-label={`${team.memberCount} 位成员`}>{team.memberCount} <span lang="en">{team.memberCount === 1 ? 'member' : 'members'}</span></span><ChevronRight className="size-4 shrink-0" aria-hidden="true" /></span></Link>
      </section>
    </div>
  </section>
}
