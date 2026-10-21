'use client'

import { useState, useTransition } from 'react'
import useSWR from 'swr'
import { Bot, Hammer, Network, Pencil, Plus, ShieldCheck, Trash2, type LucideIcon } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/reui/badge'
import { IconTile } from '@/components/reui/icon-tile'
import { deleteAgent, listAgents, listDevices, type AgentView, type DeviceView } from '@/app/actions/agents'
import { isBuiltInAgentRole, type AgentRole } from '@/lib/agent-roles'
import { useActionError } from '@/lib/use-action-error'
import { AgentDialog, HARNESS_LABELS } from './agent-dialog'

const ROLE_ICONS: Record<AgentRole, LucideIcon> = { coordinator: Network, worker: Hammer, reviewer: ShieldCheck, custom: Bot }

function AgentCard({ agent, onEdit, onDelete }: { agent: AgentView; onEdit: () => void; onDelete: () => void }) {
  const t = useTranslations('Agents')
  const Icon = ROLE_ICONS[agent.role] ?? Bot
  const builtIn = isBuiltInAgentRole(agent.role)
  const placement = [
    { label: t('device'), value: agent.deviceId ? agent.deviceName ?? t('deviceMissing') : t('auto') },
    { label: t('harness'), value: agent.harness ? HARNESS_LABELS[agent.harness] : t('auto') },
    { label: t('model'), value: agent.model ?? t('auto') },
  ]
  return (
    <div className="flex flex-col gap-3 rounded-xl border p-5">
      <div className="flex items-start gap-3">
        <IconTile variant="elevated" aria-hidden="true"><Icon /></IconTile>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{agent.name}</span>
            <Badge variant={builtIn ? 'secondary' : 'outline'} size="sm">{t(`roles.${agent.role}`)}</Badge>
          </span>
          <span className="text-xs text-muted-foreground">{agent.description || t('noDescription')}</span>
        </div>
        <span className="flex shrink-0 items-center gap-1">
          <Button size="xs" variant="ghost" onClick={onEdit} aria-label={t('editAgent', { name: agent.name })}>
            <Pencil data-icon="inline-start" />
            {t('edit')}
          </Button>
          {!builtIn && (
            <Button size="icon-xs" variant="ghost" onClick={onDelete} aria-label={t('deleteAgent', { name: agent.name })}>
              <Trash2 data-icon="inline-start" />
            </Button>
          )}
        </span>
      </div>
      <dl className="grid gap-2 sm:grid-cols-3">
        {placement.map(item => (
          <div key={item.label} className="flex flex-col gap-0.5 rounded-lg bg-muted/50 px-3 py-2">
            <dt className="text-xs text-muted-foreground">{item.label}</dt>
            <dd className="truncate text-xs font-medium">{item.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

/**
 * The Agent section: the three built-in roles plus any custom ones, each with
 * the machine, harness and model it runs on. Built-in roles are created for
 * every person on first load (see `listAgents`).
 */
export function AgentsPanel() {
  const t = useTranslations('Agents')
  const commonT = useTranslations('Common')
  const translateError = useActionError()
  const { data: agents, mutate, error } = useSWR('agents', listAgents)
  const { data: devices = [] } = useSWR<DeviceView[]>('devices', listDevices)
  const [editing, setEditing] = useState<{ agent: AgentView | null; key: number } | null>(null)
  const [deleting, setDeleting] = useState<AgentView | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const [pending, startTransition] = useTransition()

  function confirmDelete() {
    if (!deleting) return
    const target = deleting
    setDeleteError('')
    startTransition(async () => {
      try {
        const result = await deleteAgent(target.id)
        if ('error' in result) { setDeleteError(translateError(result.error)); return }
        setDeleting(null)
        void mutate()
      } catch {
        setDeleteError(translateError('agentSaveFailed'))
      }
    })
  }

  const builtIn = agents?.filter(agent => isBuiltInAgentRole(agent.role)) ?? []
  const custom = agents?.filter(agent => !isBuiltInAgentRole(agent.role)) ?? []

  return (
    <section aria-label={t('title')} className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-5 py-8">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('description')}</p>
        </div>
        <Button size="sm" onClick={() => setEditing({ agent: null, key: Date.now() })}>
          <Plus data-icon="inline-start" />
          {t('createTrigger')}
        </Button>
      </header>

      {error && <p role="alert" className="text-xs text-destructive">{t('listError')}</p>}
      {!agents && !error && (
        <div className="flex flex-col gap-3">
          {[0, 1, 2].map(index => <Skeleton key={index} className="h-32 rounded-xl" />)}
        </div>
      )}

      {agents && (
        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-medium text-muted-foreground">{t('builtInGroup')}</h2>
          {builtIn.map(agent => (
            <AgentCard key={agent.id} agent={agent} onEdit={() => setEditing({ agent, key: Date.now() })} onDelete={() => setDeleting(agent)} />
          ))}
        </div>
      )}

      {agents && (
        <div className="flex flex-col gap-3">
          <h2 className="text-xs font-medium text-muted-foreground">{t('customGroup')}</h2>
          {custom.length === 0 ? (
            <p className="rounded-xl border border-dashed px-5 py-6 text-center text-xs text-muted-foreground">{t('customEmpty')}</p>
          ) : custom.map(agent => (
            <AgentCard key={agent.id} agent={agent} onEdit={() => setEditing({ agent, key: Date.now() })} onDelete={() => setDeleting(agent)} />
          ))}
        </div>
      )}

      {devices.length === 0 && agents && (
        <p className="text-xs text-muted-foreground">{t('noDevicesHint')}</p>
      )}

      {editing && (
        <AgentDialog
          key={editing.key}
          open
          agent={editing.agent}
          devices={devices}
          onOpenChange={open => { if (!open) setEditing(null) }}
          onSaved={() => { void mutate() }}
        />
      )}

      <AlertDialog open={deleting !== null} onOpenChange={open => { if (!open) { setDeleting(null); setDeleteError('') } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle', { name: deleting?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && <p role="alert" className="text-xs text-destructive">{deleteError}</p>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{commonT('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={confirmDelete}>{t('deleteConfirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}
