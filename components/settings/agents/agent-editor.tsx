'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronLeft, Ellipsis, Laptop, RotateCcw, Trash2 } from 'lucide-react'
import { Badge } from '@/components/reui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { AgentMarkdown } from '@/components/workspace/agent-markdown'
import { createAgent, deleteAgent, resetAgentInstructions, updateAgent, type AgentInput, type AgentView, type DeviceView } from '@/app/actions/agents'
import { isBuiltInAgentRole, MAX_AGENT_INSTRUCTIONS_LENGTH, type AgentRole } from '@/lib/agent-roles'
import { useActionError } from '@/lib/use-action-error'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useMediaQuery } from '@/lib/hooks/use-media-query'
import { AgentStatusBadge, HARNESS_LABELS, HarnessIcon } from './agent-parts'
import { AvatarPicker } from './avatar-picker'
import { modelSummary, reportedModels, RuntimeFields, type Runtime } from './runtime-fields'

export type AgentDraft = AgentInput & { role: AgentRole }

export function draftOf(agent: AgentView): AgentDraft {
  const { role, name, description, instructions, deviceId, harness, model, effort, permissionMode, icon, color } = agent
  return { role, name, description, instructions, deviceId, harness, model, effort, permissionMode, icon, color }
}

/**
 * One role, built-in or custom, in the same layout: header (avatar, name,
 * status, runtime chips), then the 提示词 and 运行环境 tabs. With `agent` it
 * edits that role and saves each change; without, it is the create page for
 * a custom role and saves once on 创建.
 */
export function AgentEditor({ agent, initial, devices, onBack, onSaved, onCreated, onDeleted }: {
  agent?: AgentView
  initial: AgentDraft
  devices: DeviceView[]
  onBack: () => void
  onSaved: () => Promise<unknown>
  onCreated: (id: string) => void
  onDeleted: () => void
}) {
  const t = useTranslations('Agents')
  // Below sm the harness chip is icon-only, so its name comes from a tooltip; from sm up the label is visible and the tooltip is off.
  const harnessLabelVisible = useMediaQuery('(min-width: 40rem)', true)
  const translateError = useActionError()
  const [draft, setDraft] = useState<AgentDraft>(initial)
  const [saved, setSaved] = useState<AgentDraft>(initial)
  const [promptView, setPromptView] = useState<'preview' | 'edit'>(agent ? 'preview' : 'edit')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const builtIn = isBuiltInAgentRole(draft.role)
  const summary = draft.description || (isBuiltInAgentRole(draft.role) ? t(`roles.${draft.role}.summary`) : '')
  const runtime: Runtime = { deviceId: draft.deviceId, harness: draft.harness, model: draft.model, effort: draft.effort, permissionMode: draft.permissionMode }
  const device = devices.find(item => item.id === draft.deviceId)
  const models = reportedModels(devices, draft.deviceId, draft.harness)
  const promptDirty = draft.instructions !== saved.instructions

  /** Applies `patch` and, when editing, saves it on top of what is saved (an unsaved prompt edit stays unsaved). */
  const commit = async (patch: Partial<AgentDraft>) => {
    setDraft(current => ({ ...current, ...patch }))
    if (!agent) return
    setBusy(true)
    setError('')
    const next = { ...saved, ...patch }
    const { role: _role, ...input } = next
    const result = await updateAgent({ id: agent.id, ...input })
    setBusy(false)
    if ('error' in result) { setError(translateError(result.error)); return }
    setSaved(next)
    await onSaved()
  }
  const create = async () => {
    setBusy(true)
    setError('')
    const { role: _role, ...input } = draft
    const result = await createAgent(input)
    setBusy(false)
    if ('error' in result) { setError(translateError(result.error)); return }
    onCreated(result.id)
  }
  const reset = async () => {
    if (!agent) return
    setBusy(true)
    const result = await resetAgentInstructions(agent.id)
    setBusy(false)
    if ('error' in result) { setError(translateError(result.error)); return }
    await onSaved()
    onBack()
  }
  const remove = async () => {
    if (!agent) return
    setBusy(true)
    const result = await deleteAgent(agent.id)
    setBusy(false)
    if ('error' in result) { setError(translateError(result.error)); setConfirmDelete(false); return }
    onDeleted()
  }
  const commitText = (key: 'name' | 'description') => {
    if (draft[key].trim() === saved[key]) return
    void commit({ [key]: draft[key].trim() })
  }

  return <div className="flex flex-col gap-6">
    <Button variant="link" size="sm" className="self-start px-0 text-muted-foreground" onClick={onBack}><ChevronLeft data-icon="inline-start" />Agent</Button>

    <header className="flex items-start gap-3.5">
      <AvatarPicker role={draft.role} name={draft.name} icon={draft.icon} color={draft.color} onChange={next => void commit(next)} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex min-w-0 items-center gap-2">
          {builtIn
            ? <h1 className="truncate text-2xl font-medium tracking-tight">{draft.name}</h1>
            : <Input aria-label={t('fields.name')} placeholder={t('fields.namePlaceholder')} value={draft.name} maxLength={60}
                className="field-sizing-content h-8 w-auto min-w-24 max-w-full border-none px-0 text-2xl font-medium tracking-tight shadow-none focus-visible:ring-0 md:text-2xl dark:bg-transparent"
                onChange={event => setDraft({ ...draft, name: event.target.value })} onBlur={() => commitText('name')} />}
          <Badge variant="outline" className="shrink-0">{builtIn ? t('badges.default') : t('badges.custom')}</Badge>
          {agent && <AgentStatusBadge status={agent.status} />}
        </div>
        {builtIn
          ? <p className="text-sm text-muted-foreground">{summary}</p>
          : <Input aria-label={t('fields.summary')} placeholder={t('fields.summaryPlaceholder')} value={draft.description} maxLength={200}
              className="h-6 border-none px-0 text-sm text-muted-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
              onChange={event => setDraft({ ...draft, description: event.target.value })} onBlur={() => commitText('description')} />}
        {/* One line at every width: chips truncate rather than wrap, so picking a harness does not push the tabs down. Narrow screens show the harness as its icon. */}
        <div data-slot="agent-chips" className="mt-2 flex min-w-0 gap-1.5">
          {/* On narrow screens the chip is only the icon: focusable, with the name in a tooltip. */}
          {draft.harness && <Tooltip disabled={harnessLabelVisible}>
            <TooltipTrigger render={<Badge variant="outline" size="xl" tabIndex={0} className="min-w-0 shrink-0 gap-1.5 font-medium sm:shrink" />}>
              <HarnessIcon harness={draft.harness} /><span className="sr-only sm:not-sr-only sm:truncate">{HARNESS_LABELS[draft.harness]}</span>
            </TooltipTrigger>
            <TooltipContent>{HARNESS_LABELS[draft.harness]}</TooltipContent>
          </Tooltip>}
          {draft.harness && <Badge variant="outline" size="xl" className="min-w-0 shrink font-medium"><span className="truncate">{modelSummary(models, runtime, t('runtime.defaultModel'))}</span></Badge>}
          <Badge variant="outline" size="xl" className="ml-auto min-w-0 shrink gap-1.5 font-medium"><Laptop data-icon="inline-start" /><span className="truncate">{device?.name ?? t('runtime.noDevice')}</span></Badge>
        </div>
      </div>
      {agent && <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="icon" aria-label={t('actions.more')} title={t('actions.more')} />}><Ellipsis data-icon="inline-start" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuGroup>
            {builtIn
              ? <DropdownMenuItem onClick={() => void reset()}><RotateCcw aria-hidden="true" />{t('actions.reset')}</DropdownMenuItem>
              : <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2 aria-hidden="true" />{t('actions.delete')}</DropdownMenuItem>}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>}
    </header>

    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

    <Tabs defaultValue="prompt" className="gap-6">
      <TabsList aria-label={t('tabs.label')}>
        <TabsTrigger value="prompt" className="px-3">{t('tabs.prompt')}</TabsTrigger>
        <TabsTrigger value="runtime" className="px-3">{t('tabs.runtime')}</TabsTrigger>
      </TabsList>
      <TabsContent value="prompt" className="flex flex-col gap-3">
        <section aria-label={t('prompt.title')} className="overflow-hidden rounded-2xl border bg-card">
          <Tabs value={promptView} onValueChange={value => setPromptView(value as 'preview' | 'edit')} className="gap-0">
            <div className="flex items-center justify-between gap-3 border-b bg-sidebar py-2 pr-3 pl-4">
              <span className="text-sm font-medium">{t('prompt.title')}</span>
              <TabsList aria-label={t('prompt.view')} className="h-7">
                <TabsTrigger value="preview" className="px-2.5">{t('prompt.preview')}</TabsTrigger>
                <TabsTrigger value="edit" className="px-2.5">{t('prompt.edit')}</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="preview" className="px-6 pt-3 pb-6">
              {draft.instructions.trim() ? <AgentMarkdown text={draft.instructions} /> : <p className="py-6 text-center text-sm text-muted-foreground">{t('prompt.empty')}</p>}
            </TabsContent>
            <TabsContent value="edit">
              <Textarea aria-label={t('prompt.title')} value={draft.instructions} maxLength={MAX_AGENT_INSTRUCTIONS_LENGTH} placeholder={t('prompt.placeholder')}
                className="field-sizing-fixed min-h-80 resize-y rounded-none border-none px-4 py-4 font-mono text-xs leading-relaxed shadow-none focus-visible:ring-0 md:text-xs dark:bg-transparent"
                onChange={event => setDraft({ ...draft, instructions: event.target.value })} />
              <div className="flex justify-between border-t px-4 py-2 text-xs text-muted-foreground">
                <span>{t('prompt.markdown')}</span>
                <span className="tabular-nums">{draft.instructions.length.toLocaleString()} / {MAX_AGENT_INSTRUCTIONS_LENGTH.toLocaleString()}</span>
              </div>
            </TabsContent>
          </Tabs>
        </section>
        {agent && promptDirty && <div className="flex justify-end gap-2">
          <Button variant="outline" className="rounded-full px-4" disabled={busy} onClick={() => setDraft({ ...draft, instructions: saved.instructions })}>{t('actions.cancel')}</Button>
          <Button className="rounded-full bg-agent-accent px-4 text-agent-accent-foreground hover:bg-agent-accent/90" disabled={busy} onClick={() => void commit({ instructions: draft.instructions })}>{t('actions.save')}</Button>
        </div>}
      </TabsContent>
      <TabsContent value="runtime">
        <RuntimeFields devices={devices} runtime={runtime} onChange={next => void commit(next)} />
      </TabsContent>
    </Tabs>

    {!agent && <div className="flex justify-end gap-2">
      <Button variant="outline" size="lg" className="rounded-full px-4" onClick={onBack}>{t('actions.cancel')}</Button>
      <Button size="lg" className="rounded-full bg-agent-accent px-4 text-agent-accent-foreground hover:bg-agent-accent/90" disabled={busy || !draft.name.trim()} onClick={() => void create()}>{t('actions.create')}</Button>
    </div>}

    <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteDialog.title', { name: draft.name })}</AlertDialogTitle>
          <AlertDialogDescription>{t('deleteDialog.description')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void remove()}>{t('actions.delete')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
}

