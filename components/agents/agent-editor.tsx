'use client'

import { useState, useTransition } from 'react'
import { Cpu, RotateCcw, Sparkles, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/reui/badge'
import { Frame, FrameDescription, FrameFooter, FrameHeader, FramePanel, FrameTitle } from '@/components/reui/frame'
import { IconTile } from '@/components/reui/icon-tile'
import { createAgent, deleteAgent, resetAgentInstructions, updateAgent, type AgentView, type DeviceView } from '@/app/actions/agents'
import { resolveAgentPlacement, SUGGESTED_MODELS } from '@/lib/agent-placement'
import { BUILT_IN_AGENT_PRESETS, MAX_AGENT_INSTRUCTIONS_LENGTH, isBuiltInAgentRole, type AgentRole } from '@/lib/agent-roles'
import { SUPPORTED_HARNESSES, type SupportedHarness } from '@/lib/db/schema'
import { useActionError } from '@/lib/use-action-error'
import { ROLE_ICONS } from './role-icons'

export const HARNESS_LABELS: Record<SupportedHarness, string> = { claude_code: 'Claude Code', codex: 'Codex' }

/** Select values for the choices that are not a stored id or name. */
const AUTO = '__auto__'
const CUSTOM = '__custom__'

interface Draft {
  name: string
  description: string
  instructions: string
  deviceId: string
  harness: string
  /** AUTO, CUSTOM or one of the suggested names. */
  modelChoice: string
  customModel: string
}

function suggestedFor(harness: string): readonly string[] {
  if (harness === AUTO) return [...new Set(SUPPORTED_HARNESSES.flatMap(item => SUGGESTED_MODELS[item]))]
  return SUGGESTED_MODELS[harness as SupportedHarness] ?? []
}

function draftOf(agent: AgentView | null): Draft {
  const harness = agent?.harness ?? AUTO
  const model = agent?.model ?? null
  const suggested = suggestedFor(harness).includes(model ?? '')
  return {
    name: agent?.name ?? '',
    description: agent?.description ?? '',
    instructions: agent?.instructions ?? '',
    deviceId: agent?.deviceId ?? AUTO,
    harness,
    modelChoice: model === null ? AUTO : suggested ? model : CUSTOM,
    customModel: model !== null && !suggested ? model : '',
  }
}

function sameDraft(a: Draft, b: Draft): boolean {
  return (Object.keys(a) as (keyof Draft)[]).every(key => a[key] === b[key])
}

function installedOn(device: DeviceView | undefined, harness: SupportedHarness): boolean {
  return Boolean(device?.harnesses.some(info => info.harness === harness && info.installed))
}

/**
 * The right-hand side of the Agent page: one role, edited in place. Who it is
 * (name, summary, prompt) and where it runs (machine, harness, model). Each
 * placement field may stay on auto, which the server resolves when a run is
 * queued; the preview line shows what auto would pick right now.
 */
export function AgentEditor({ agent, devices, onSaved, onDeleted, onCancelNew }: {
  /** null: a new custom role that is not saved yet. */
  agent: AgentView | null
  devices: DeviceView[]
  onSaved: (id: string) => void
  onDeleted: () => void
  onCancelNew: () => void
}) {
  const t = useTranslations('Agents')
  const commonT = useTranslations('Common')
  const translateError = useActionError()
  const [initial, setInitial] = useState<Draft>(() => draftOf(agent))
  const [draft, setDraft] = useState<Draft>(initial)
  const [error, setError] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, startTransition] = useTransition()
  const role: AgentRole = agent?.role ?? 'custom'
  const builtIn = isBuiltInAgentRole(role)
  const Icon = ROLE_ICONS[role]
  const device = devices.find(item => item.id === draft.deviceId)
  const suggested = suggestedFor(draft.harness)
  const dirty = !agent || !sameDraft(draft, initial)

  function patch(next: Partial<Draft>) {
    setDraft(previous => ({ ...previous, ...next }))
  }

  function chooseDevice(deviceId: string) {
    const next = devices.find(item => item.id === deviceId)
    // A harness the newly pinned machine does not have goes back to auto.
    const harness = draft.harness !== AUTO && next && !installedOn(next, draft.harness as SupportedHarness) ? AUTO : draft.harness
    patch({ deviceId, harness })
  }

  function chooseHarness(harness: string) {
    const keep = draft.modelChoice === AUTO || draft.modelChoice === CUSTOM || suggestedFor(harness).includes(draft.modelChoice)
    patch({ harness, modelChoice: keep ? draft.modelChoice : AUTO })
  }

  function modelOf(value: Draft): string | null {
    if (value.modelChoice === AUTO) return null
    if (value.modelChoice === CUSTOM) return value.customModel.trim() || null
    return value.modelChoice
  }

  const preview = resolveAgentPlacement(
    { deviceId: draft.deviceId === AUTO ? null : draft.deviceId, harness: draft.harness === AUTO ? null : draft.harness as SupportedHarness, model: modelOf(draft) },
    devices,
  )
  const previewText = preview.ok
    ? t('previewOk', {
      device: devices.find(item => item.id === preview.deviceId)?.name ?? '',
      harness: HARNESS_LABELS[preview.harness],
      model: preview.model ?? t('cliDefault'),
    })
    : t(`preview.${preview.reason}`)

  function save() {
    setError('')
    const input = {
      name: draft.name, description: draft.description, instructions: draft.instructions,
      deviceId: draft.deviceId === AUTO ? null : draft.deviceId,
      harness: draft.harness === AUTO ? null : draft.harness as SupportedHarness,
      model: modelOf(draft),
    }
    startTransition(async () => {
      try {
        const result = agent ? await updateAgent({ id: agent.id, ...input }) : await createAgent(input)
        if ('error' in result) { setError(translateError(result.error)); return }
        setInitial(draft)
        onSaved(agent ? agent.id : 'id' in result ? result.id : '')
      } catch {
        setError(translateError(agent ? 'agentSaveFailed' : 'agentAddFailed'))
      }
    })
  }

  function resetPrompt() {
    if (!agent || !isBuiltInAgentRole(agent.role)) return
    const preset = BUILT_IN_AGENT_PRESETS[agent.role]
    setError('')
    startTransition(async () => {
      try {
        const result = await resetAgentInstructions(agent.id)
        if ('error' in result) { setError(translateError(result.error)); return }
        const next = { ...draft, description: preset.description, instructions: preset.instructions }
        setDraft(next)
        setInitial(previous => ({ ...previous, description: preset.description, instructions: preset.instructions }))
        onSaved(agent.id)
      } catch {
        setError(translateError('agentSaveFailed'))
      }
    })
  }

  function remove() {
    if (!agent) return
    setError('')
    startTransition(async () => {
      try {
        const result = await deleteAgent(agent.id)
        if ('error' in result) { setError(translateError(result.error)); setConfirmDelete(false); return }
        setConfirmDelete(false)
        onDeleted()
      } catch {
        setError(translateError('agentSaveFailed'))
        setConfirmDelete(false)
      }
    })
  }

  const deviceItems = [{ value: AUTO, label: t('auto') }, ...devices.map(item => ({ value: item.id, label: item.name }))]
  const harnessItems = [{ value: AUTO, label: t('auto') }, ...SUPPORTED_HARNESSES.map(item => ({ value: item, label: HARNESS_LABELS[item] }))]
  const modelItems = [
    { value: AUTO, label: t('modelAuto') },
    ...suggested.map(item => ({ value: item, label: item })),
    { value: CUSTOM, label: t('modelCustom') },
  ]

  return (
    <Frame spacing="lg" className="min-w-0" role="region" aria-label={agent ? t('editTitle', { name: agent.name }) : t('createTitle')}>
      <FrameHeader className="flex-row items-center gap-3">
        <IconTile size="sm" variant="elevated" aria-hidden="true"><Icon /></IconTile>
        <div className="flex min-w-0 flex-1 flex-col">
          <FrameTitle className="flex items-center gap-2">
            <span className="truncate">{agent ? agent.name : t('createTitle')}</span>
            <Badge variant={builtIn ? 'info-light' : 'outline'} size="sm">{t(`roles.${role}`)}</Badge>
          </FrameTitle>
          <FrameDescription className="text-xs">{builtIn ? t('builtInHint') : t('customHint')}</FrameDescription>
        </div>
      </FrameHeader>

      <FramePanel>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="agent-name">{t('name')}</FieldLabel>
              <Input id="agent-name" value={draft.name} maxLength={60} placeholder={t('namePlaceholder')} onChange={event => patch({ name: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-description">{t('summary')}</FieldLabel>
              <Input id="agent-description" value={draft.description} maxLength={200} placeholder={builtIn ? t(`roleSummary.${role}`) : t('summaryPlaceholder')} onChange={event => patch({ description: event.target.value })} />
            </Field>
          </div>
        </FieldGroup>
      </FramePanel>

      <FramePanel>
        <FieldGroup>
          <div className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-sm font-medium"><Cpu className="size-4 text-muted-foreground" aria-hidden="true" />{t('runtime')}</span>
            <span className="text-xs text-muted-foreground">{t('autoHint')}</span>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field>
              <FieldLabel htmlFor="agent-device">{t('device')}</FieldLabel>
              <Select value={draft.deviceId} items={deviceItems} onValueChange={value => chooseDevice(value ?? AUTO)}>
                <SelectTrigger id="agent-device" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={AUTO}>{t('auto')}</SelectItem>
                  </SelectGroup>
                  {devices.length > 0 && (
                    <SelectGroup>
                      <SelectLabel>{t('devicesGroup')}</SelectLabel>
                      {devices.map(item => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.online ? item.name : t('deviceOffline', { name: item.name })}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  )}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-harness">{t('harness')}</FieldLabel>
              <Select value={draft.harness} items={harnessItems} onValueChange={value => chooseHarness(value ?? AUTO)}>
                <SelectTrigger id="agent-harness" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectItem value={AUTO}>{t('auto')}</SelectItem>
                    {SUPPORTED_HARNESSES.map(item => (
                      <SelectItem key={item} value={item} disabled={Boolean(device) && !installedOn(device, item)}>
                        {HARNESS_LABELS[item]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-model">{t('model')}</FieldLabel>
              <Select value={draft.modelChoice} items={modelItems} onValueChange={value => patch({ modelChoice: value ?? AUTO })}>
                <SelectTrigger id="agent-model" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {modelItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                  </SelectGroup>
                </SelectContent>
              </Select>
            </Field>
          </div>
          {draft.modelChoice === CUSTOM && (
            <Field>
              <FieldLabel htmlFor="agent-custom-model">{t('customModel')}</FieldLabel>
              <Input id="agent-custom-model" value={draft.customModel} maxLength={120} placeholder={t('customModelPlaceholder')} onChange={event => patch({ customModel: event.target.value })} />
            </Field>
          )}
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-lg bg-muted/60 px-3 py-2 text-xs" role="status">
            <Sparkles className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="shrink-0 text-muted-foreground">{t('previewLabel')}</span>
            <span className="min-w-0 font-medium">{previewText}</span>
          </div>
        </FieldGroup>
      </FramePanel>

      <FramePanel>
        <FieldGroup>
          <Field>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="agent-instructions">{t('instructions')}</FieldLabel>
              {builtIn && (
                <Button size="xs" variant="ghost" disabled={pending} onClick={resetPrompt}>
                  <RotateCcw data-icon="inline-start" />
                  {t('resetPrompt')}
                </Button>
              )}
            </div>
            <Textarea
              id="agent-instructions"
              value={draft.instructions}
              maxLength={MAX_AGENT_INSTRUCTIONS_LENGTH}
              placeholder={t('instructionsPlaceholder')}
              className="h-96 max-h-96 min-h-60 overflow-y-auto font-mono text-xs leading-5 field-sizing-fixed"
              onChange={event => patch({ instructions: event.target.value })}
            />
            <FieldDescription className="text-right tabular-nums">
              {t('instructionsCount', { count: draft.instructions.length, max: MAX_AGENT_INSTRUCTIONS_LENGTH })}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </FramePanel>

      <FrameFooter className="flex-row flex-wrap items-center gap-2">
        {agent && !builtIn && (
          <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirmDelete(true)}>
            <Trash2 data-icon="inline-start" />
            {t('deleteConfirm')}
          </Button>
        )}
        {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
        <span className="ml-auto flex items-center gap-2">
          {!agent ? (
            <Button variant="outline" size="sm" className="rounded-full" disabled={pending} onClick={onCancelNew}>{commonT('cancel')}</Button>
          ) : dirty && (
            <Button variant="outline" size="sm" className="rounded-full" disabled={pending} onClick={() => setDraft(initial)}>{t('discard')}</Button>
          )}
          <Button size="sm" className="rounded-full bg-workspace-accent text-workspace-accent-foreground hover:bg-workspace-accent/90" disabled={pending || !dirty || !draft.name.trim()} onClick={save}>
            {pending && <Spinner data-icon="inline-start" />}
            {agent ? t('save') : t('create')}
          </Button>
        </span>
      </FrameFooter>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle', { name: agent?.name ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>{t('deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pending}>{commonT('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={pending} onClick={remove}>{t('deleteConfirm')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Frame>
  )
}
