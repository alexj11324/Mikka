'use client'

import { useState } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Ellipsis, Plus } from '@/components/icons'
import { createWorkspaceIssueState, deleteWorkspaceIssueState, reorderWorkspaceIssueStates, setDefaultWorkspaceIssueState, updateWorkspaceIssueState } from '@/app/actions/issue-states'
import type { ActionResult } from '@/lib/action-result'
import { useActionError } from '@/lib/use-action-error'
import { useIssueStates } from '@/hooks/use-issue-states'
import { ISSUE_STATUS_CODES, type IssueStatus } from '@/lib/issue-meta'
import { ISSUE_STATUS_MARKS } from '@/lib/state-mark'
import { ISSUE_STATE_COLORS, ISSUE_STATE_ICONS, ISSUE_STATE_NAME_MAX, groupIssueStates, issueStateLabel, issueStateType, type IssueStateIcon, type IssueStateType, type IssueStateView } from '@/lib/issue-states'
import type { MarkTone } from '@/lib/state-mark'
import { Mark } from '@/components/workspace/state-mark'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SettingsLoading, SettingsSaveError, SettingsSection, SettingRow, settingsSectionAction } from './primitives'

type Editing = { state?: IssueStateView; type: IssueStateType }

/**
 * Capy's Issue states (decision 2026-11-19-2115): the workspace's task states under Open and Closed, in their order.
 * Members read the page; admins create, rename, restyle, reorder, pick each category's default and delete with
 * MoveAndDelete. Needs you and Waiting are a thread's run state, not rows here.
 */
export function IssueStatesSettings({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('Settings.issueStates'), common = useTranslations('Common'), tIssue = useTranslations('Issue')
  const actionError = useActionError()
  const { states, canEdit, error, mutate } = useIssueStates(workspaceId, { live: true })
  const [editing, setEditing] = useState<Editing | null>(null)
  const [deleting, setDeleting] = useState<IssueStateView | null>(null)
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const label = (state: Pick<IssueStateView, 'name' | 'category'>) => issueStateLabel(state, category => tIssue(`status.${category}`))
  const grouped = groupIssueStates(states ?? [])

  async function run(write: () => Promise<ActionResult<unknown>>): Promise<boolean> {
    setPending(true); setFailure(null)
    try {
      const result = await write()
      if (result.error) { setFailure(actionError(result.error)); return false }
      return true
    } catch { setFailure(actionError()); return false }
    finally { setPending(false); void mutate() }
  }

  function move(state: IssueStateView, offset: -1 | 1) {
    const ordered = [...grouped.open, ...grouped.closed]
    const group = state.type === 'open' ? grouped.open : grouped.closed
    const index = group.indexOf(state), swap = group[index + offset]
    if (!swap) return
    const ids = ordered.map(item => item.id === state.id ? swap.id : item.id === swap.id ? state.id : item.id)
    void run(() => reorderWorkspaceIssueStates({ workspaceId, ids }))
  }

  const section = (type: IssueStateType, rows: IssueStateView[]) => <SettingsSection id={`issue-states-${type}`} title={t(type)}
    action={canEdit ? <Button {...settingsSectionAction} disabled={pending} onClick={() => setEditing({ type })}><Plus data-icon="inline-start" />{t('new')}</Button> : undefined}>
    {rows.map((state, index) => <SettingRow key={state.id} icon={<Mark shape={state.icon} tone={state.color} size="md" />} title={label(state)}
      description={t('tasks', { count: state.taskCount })}>
      <div className="flex items-center gap-2">
        {/* Every category has a default; the mark only says something where a category has more than one state. */}
        {state.isDefault && (states ?? []).filter(other => other.category === state.category).length > 1 && <Badge variant="secondary">{t('default')}</Badge>}
        {canEdit && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" disabled={pending} aria-label={t('actions', { name: label(state) })} />}><Ellipsis /></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => setEditing({ state, type })}>{t('look')}</DropdownMenuItem>
              <DropdownMenuItem disabled={state.isDefault} onClick={() => { void run(() => setDefaultWorkspaceIssueState({ workspaceId, id: state.id })) }}>{t('makeDefault')}</DropdownMenuItem>
              <DropdownMenuItem disabled={index === 0} onClick={() => move(state, -1)}>{t('moveUp')}</DropdownMenuItem>
              <DropdownMenuItem disabled={index === rows.length - 1} onClick={() => move(state, 1)}>{t('moveDown')}</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem variant="destructive" disabled={state.isDefault} onClick={() => setDeleting(state)}>{t('delete')}</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>}
      </div>
    </SettingRow>)}
  </SettingsSection>

  return <div className="flex flex-col gap-6" data-settings-state={error ? 'error' : states ? 'ready' : 'loading'}>
    {!states && !error && <SettingsLoading rows={4} label={common('loading')} />}
    {states && section('open', grouped.open)}
    {states && section('closed', grouped.closed)}
    {error && !states && <SettingsSaveError message={actionError(error === 'generic' ? undefined : error)} retryLabel={common('retry')} onRetry={() => { void mutate() }} />}
    {failure && <FieldError>{failure}</FieldError>}
    {canEdit && editing && <IssueStateEditor key={editing.state?.id ?? `new-${editing.type}`} type={editing.type} state={editing.state} label={label} pending={pending}
      onClose={() => setEditing(null)}
      onSave={async values => {
        const saved = editing.state
          ? await run(() => updateWorkspaceIssueState({ workspaceId, id: editing.state!.id, name: values.name, icon: values.icon, color: values.color }))
          : await run(() => createWorkspaceIssueState({ workspaceId, name: values.name ?? '', category: values.category, icon: values.icon, color: values.color }))
        if (saved) setEditing(null)
      }} />}
    {canEdit && deleting && states && <MoveAndDelete key={deleting.id} state={deleting} states={states} label={label} pending={pending}
      onClose={() => setDeleting(null)}
      onDelete={async moveTo => { if (await run(() => deleteWorkspaceIssueState({ workspaceId, id: deleting.id, moveTo }))) setDeleting(null) }} />}
  </div>
}

type EditorValues = { name: string | null; category: IssueStatus; icon: IssueStateIcon; color: MarkTone }

/** New state, or a state's name, icon and color. A state's category is fixed once it exists. */
function IssueStateEditor({ type, state, label, pending, onClose, onSave }: {
  type: IssueStateType; state?: IssueStateView; label: (state: Pick<IssueStateView, 'name' | 'category'>) => string; pending: boolean
  onClose: () => void; onSave: (values: EditorValues) => Promise<void>
}) {
  const t = useTranslations('Settings.issueStates'), tIssue = useTranslations('Issue')
  const categories = ISSUE_STATUS_CODES.filter(category => issueStateType(category) === type)
  const [name, setName] = useState(state ? label(state) : '')
  const [category, setCategory] = useState<IssueStatus>(state?.category ?? categories[0])
  const [icon, setIcon] = useState<IssueStateIcon>(state?.icon ?? ISSUE_STATUS_MARKS[categories[0]].shape as IssueStateIcon)
  const [color, setColor] = useState<MarkTone>(state?.color ?? ISSUE_STATUS_MARKS[categories[0]].tone)
  const trimmed = name.trim()
  // A built-in state left at its translated name keeps following the language.
  const storedName = state && state.name === null && trimmed === label(state) ? null : trimmed
  const categoryItems = categories.map(value => ({ value, label: tIssue(`status.${value}`) }))
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent aria-describedby={undefined} className="sm:max-w-md">
      <DialogHeader><DialogTitle>{state ? label(state) : t('newIn', { type: t(type) })}</DialogTitle></DialogHeader>
      <form onSubmit={event => { event.preventDefault(); if (trimmed) void onSave({ name: storedName, category, icon, color }) }}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="issue-state-name">{t('name')}</FieldLabel>
            <div className="flex items-center gap-2">
              <Mark shape={icon} tone={color} size="md" />
              <Input id="issue-state-name" autoFocus maxLength={ISSUE_STATE_NAME_MAX} value={name} onChange={event => setName(event.target.value)} />
            </div>
            {state && state.name !== null && <Button type="button" variant="link" size="sm" className="self-start px-0" onClick={() => setName(tIssue(`status.${state.category}`))}>{t('resetName')}</Button>}
          </Field>
          {!state && <Field>
            <FieldLabel>{t('category')}</FieldLabel>
            <Select value={category} items={categoryItems} onValueChange={value => {
              if (!value) return
              const next = value as IssueStatus
              setCategory(next); setIcon(ISSUE_STATUS_MARKS[next].shape as IssueStateIcon); setColor(ISSUE_STATUS_MARKS[next].tone)
            }}>
              <SelectTrigger aria-label={t('category')}><SelectValue /></SelectTrigger>
              <SelectContent><SelectGroup>{categoryItems.map(item => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectGroup></SelectContent>
            </Select>
          </Field>}
          <Field>
            <FieldLabel>{t('icon')}</FieldLabel>
            <ToggleGroup aria-label={t('icon')} className="flex-wrap justify-start" value={[icon]} onValueChange={(values: string[]) => { if (values[0]) setIcon(values[0] as IssueStateIcon) }}>
              {ISSUE_STATE_ICONS.map(shape => <ToggleGroupItem key={shape} value={shape} aria-label={shape} size="sm"><Mark shape={shape} tone={color} /></ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
          <Field>
            <FieldLabel>{t('color')}</FieldLabel>
            <ToggleGroup aria-label={t('color')} className="flex-wrap justify-start" value={[color]} onValueChange={(values: string[]) => { if (values[0]) setColor(values[0] as MarkTone) }}>
              {ISSUE_STATE_COLORS.map(tone => <ToggleGroupItem key={tone} value={tone} aria-label={t(`colors.${tone}`)} title={t(`colors.${tone}`)} size="sm"><Mark shape={icon} tone={tone} /></ToggleGroupItem>)}
            </ToggleGroup>
          </Field>
        </FieldGroup>
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
          <Button type="submit" disabled={pending || !trimmed}>{state ? t('save') : t('create')}</Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
}

/** Capy's MoveAndDelete: pick where the state's tasks go, then the state is removed. */
function MoveAndDelete({ state, states, label, pending, onClose, onDelete }: {
  state: IssueStateView; states: IssueStateView[]; label: (state: Pick<IssueStateView, 'name' | 'category'>) => string; pending: boolean
  onClose: () => void; onDelete: (moveTo: string) => Promise<void>
}) {
  const t = useTranslations('Settings.issueStates')
  const targets = groupIssueStates(states.filter(item => item.id !== state.id))
  const ordered = [...targets.open, ...targets.closed]
  const [moveTo, setMoveTo] = useState(states.find(item => item.isDefault && item.category === state.category)?.id ?? ordered[0]?.id ?? '')
  const items = ordered.map(item => ({ value: item.id, label: label(item) }))
  return <Dialog open onOpenChange={open => { if (!open && !pending) onClose() }}>
    <DialogContent aria-describedby={undefined} className="sm:max-w-md">
      <DialogHeader><DialogTitle>{t('deleteTitle', { name: label(state) })}</DialogTitle></DialogHeader>
      <FieldGroup><Field>
        <FieldLabel>{t('moveTo')}</FieldLabel>
        <Select value={moveTo} items={items} onValueChange={value => { if (value) setMoveTo(value) }}>
          <SelectTrigger aria-label={t('moveTo')}><SelectValue /></SelectTrigger>
          <SelectContent>
            {([['open', targets.open], ['closed', targets.closed]] as const).map(([type, group]) => group.length > 0 && <SelectGroup key={type}>
              {group.map(item => <SelectItem key={item.id} value={item.id}><Mark shape={item.icon} tone={item.color} />{label(item)}</SelectItem>)}
            </SelectGroup>)}
          </SelectContent>
        </Select>
      </Field></FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onClose}>{t('cancel')}</Button>
        <Button type="button" variant="destructive" disabled={pending || !moveTo} onClick={() => { void onDelete(moveTo) }}>{t('moveAndDelete')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
