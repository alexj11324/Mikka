'use client'

import { useState, useTransition } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { createAgent, resetAgentInstructions, updateAgent, type AgentView, type DeviceView } from '@/app/actions/agents'
import { SUGGESTED_MODELS } from '@/lib/agent-placement'
import { BUILT_IN_AGENT_PRESETS, MAX_AGENT_INSTRUCTIONS_LENGTH, isBuiltInAgentRole } from '@/lib/agent-roles'
import { SUPPORTED_HARNESSES, type SupportedHarness } from '@/lib/db/schema'
import { useActionError } from '@/lib/use-action-error'

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

function installedOn(device: DeviceView | undefined, harness: SupportedHarness): boolean {
  return Boolean(device?.harnesses.some(info => info.harness === harness && info.installed))
}

/**
 * Creates a custom role or edits any role: who it is (name, prompt) and where
 * it runs (machine, harness, model). Each placement field may stay on auto,
 * which the server resolves when a run is queued.
 */
export function AgentDialog({ open, agent, devices, onOpenChange, onSaved }: {
  open: boolean
  /** null: a new custom role. */
  agent: AgentView | null
  devices: DeviceView[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const t = useTranslations('Agents')
  const commonT = useTranslations('Common')
  const translateError = useActionError()
  const [draft, setDraft] = useState<Draft>(() => draftOf(agent))
  const [error, setError] = useState('')
  const [pending, startTransition] = useTransition()
  const builtIn = agent ? isBuiltInAgentRole(agent.role) : false
  const device = devices.find(item => item.id === draft.deviceId)
  const suggested = suggestedFor(draft.harness)

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

  function save() {
    setError('')
    const model = draft.modelChoice === AUTO ? null : draft.modelChoice === CUSTOM ? draft.customModel.trim() || null : draft.modelChoice
    const input = {
      name: draft.name, description: draft.description, instructions: draft.instructions,
      deviceId: draft.deviceId === AUTO ? null : draft.deviceId,
      harness: draft.harness === AUTO ? null : draft.harness as SupportedHarness,
      model,
    }
    startTransition(async () => {
      try {
        const result = agent ? await updateAgent({ id: agent.id, ...input }) : await createAgent(input)
        if ('error' in result) { setError(translateError(result.error)); return }
        onSaved()
        onOpenChange(false)
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
        patch({ description: preset.description, instructions: preset.instructions })
        onSaved()
      } catch {
        setError(translateError('agentSaveFailed'))
      }
    })
  }

  const deviceItems = [
    { value: AUTO, label: t('auto') },
    ...devices.map(item => ({ value: item.id, label: item.name })),
  ]
  const harnessItems = [
    { value: AUTO, label: t('auto') },
    ...SUPPORTED_HARNESSES.map(item => ({ value: item, label: HARNESS_LABELS[item] })),
  ]
  const modelItems = [
    { value: AUTO, label: t('modelAuto') },
    ...suggested.map(item => ({ value: item, label: item })),
    { value: CUSTOM, label: t('modelCustom') },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent closeLabel={commonT('close')} className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{agent ? t('editTitle', { name: agent.name }) : t('createTitle')}</DialogTitle>
          <DialogDescription>{agent ? t('editDescription') : t('createDescription')}</DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="agent-name">{t('name')}</FieldLabel>
              <Input id="agent-name" value={draft.name} maxLength={60} placeholder={t('namePlaceholder')} onChange={event => patch({ name: event.target.value })} />
            </Field>
            <Field>
              <FieldLabel htmlFor="agent-description">{t('summary')}</FieldLabel>
              <Input id="agent-description" value={draft.description} maxLength={200} placeholder={t('summaryPlaceholder')} onChange={event => patch({ description: event.target.value })} />
            </Field>
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
                  {devices.length > 0 && <SelectSeparator />}
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
          <FieldDescription>{t('autoHint')}</FieldDescription>
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
              className="min-h-64 font-mono text-xs"
              onChange={event => patch({ instructions: event.target.value })}
            />
            <FieldDescription>
              {t('instructionsCount', { count: draft.instructions.length, max: MAX_AGENT_INSTRUCTIONS_LENGTH })}
            </FieldDescription>
          </Field>
        </FieldGroup>
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={pending} onClick={() => onOpenChange(false)}>{commonT('cancel')}</Button>
          <Button disabled={pending || !draft.name.trim()} onClick={save}>
            {pending && <Spinner data-icon="inline-start" />}
            {agent ? t('save') : t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
