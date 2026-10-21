'use client'

import Link from 'next/link'
import { ArrowLeft, Globe2, Pencil, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

type Team = { id: string; workspaceId: string; name: string; identifier: string; description: string; memberCount: number }

export function TeamSettingsDetails({ team, canManage, onEdit, onMembers }: { team: Team; canManage: boolean; onEdit: () => void; onMembers: () => void }) {
  return <section className="flex max-w-3xl flex-col gap-8" aria-label={`${team.name} 团队设置`}>
    <Button variant="ghost" size="sm" className="self-start" nativeButton={false} role="link" render={<Link href={`/settings/teams?workspace=${team.workspaceId}`} />}><ArrowLeft data-icon="inline-start" />全部团队</Button>
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="flex flex-col gap-2"><h1 className="text-2xl font-semibold tracking-tight">{team.name}</h1><p className="text-sm text-muted-foreground">团队基本信息与成员管理</p></div>{canManage && <Button variant="outline" size="sm" onClick={onEdit}><Pencil data-icon="inline-start" />编辑团队</Button>}</header>
    <FieldGroup className="rounded-xl border bg-muted/30 p-5"><Field orientation="responsive"><FieldLabel htmlFor="team-settings-name">名称</FieldLabel><Input id="team-settings-name" value={team.name} readOnly /></Field><Field orientation="responsive"><FieldLabel htmlFor="team-settings-identifier">团队标识</FieldLabel><Input id="team-settings-identifier" value={team.identifier} readOnly /></Field><Field orientation="responsive"><FieldLabel htmlFor="team-settings-description">简介</FieldLabel><Textarea id="team-settings-description" value={team.description} placeholder="暂无简介" rows={3} readOnly /></Field></FieldGroup>
    <div className="flex flex-wrap items-center justify-between gap-4"><div className="flex flex-col gap-2"><span className="text-sm font-medium">团队可见性</span><p className="text-sm text-muted-foreground">仅当前工作区的启用成员可访问，不公开到互联网。</p></div><Badge variant="outline"><Globe2 />公开团队</Badge></div>
    <div className="flex flex-wrap items-center justify-between gap-4"><div className="flex flex-col gap-2"><h2 className="text-sm font-medium">成员</h2><p className="text-sm text-muted-foreground">{team.memberCount} 位团队成员</p></div><Button variant="outline" size="sm" onClick={onMembers}><Users data-icon="inline-start" />{canManage ? '管理团队成员' : '查看团队成员'}</Button></div>
    <Button variant="ghost" className="self-start" nativeButton={false} role="link" render={<Link href={`/?team=${team.id}`} />}>返回团队主页</Button>
  </section>
}
