'use client'

import { useState, type ReactNode } from 'react'
import { useTranslations } from '@/lib/intl/i18n-client'
import { Check } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from '@/components/ui/command'
import { useIssueStates } from '@/hooks/use-issue-states'
import { ISSUE_STATUS_CODES, type IssueStatus } from '@/lib/issue-meta'
import { ISSUE_STATUS_MARKS } from '@/lib/state-mark'
import { filterIssueStates, groupIssueStates, issueStateLabel, issueStateType, taskIssueState, type IssueStateView } from '@/lib/issue-states'
import { Mark } from './state-mark'
import { ROW_VALUE } from './issue-property-row'

/** What the picker lists: the workspace's states, or the seven categories while they load or outside a workspace. */
type Choice = Pick<IssueStateView, 'name' | 'icon' | 'color' | 'category' | 'type' | 'position' | 'isDefault'> & { id: string | null }

const BUILT_IN: readonly Choice[] = ISSUE_STATUS_CODES.map((category, index) => ({
  id: null, name: null, icon: ISSUE_STATUS_MARKS[category].shape as IssueStateView['icon'], color: ISSUE_STATUS_MARKS[category].tone,
  category, type: issueStateType(category), position: (index + 1) * 1000, isDefault: true,
}))

/**
 * Capy's state picker (decision 2026-11-19-2115): the workspace's states under Open and Closed, a search, and 1–9 to
 * pick in the listed order. `onChange` gets the state's category as the status and its id (null for a built-in
 * category, before the workspace's states have loaded).
 */
export function IssueStatePicker({ workspaceId, status, stateId, label, variant = 'icon', disabled, trigger, onChange }: {
  workspaceId: string | null | undefined
  status: string
  stateId?: string | null
  /** The property's name for the trigger's label and the menu ("Status"). */
  label: string
  /** icon: the mark alone (board cards, sub-task rows); row: mark and name (the task page's properties). */
  variant?: 'icon' | 'row'
  disabled?: boolean
  /** Drawn in place of the mark, e.g. the task's agent state on the properties row. */
  trigger?: ReactNode
  onChange: (status: IssueStatus, stateId: string | null) => unknown
}) {
  const t = useTranslations('Issue.stateMenu')
  const tCommon = useTranslations('Common')
  const tIssue = useTranslations('Issue')
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const { states, error } = useIssueStates(workspaceId)
  const choices: readonly Choice[] = states?.length ? states : BUILT_IN
  const categoryLabel = (category: IssueStatus) => tIssue(`status.${category}`)
  const current = taskIssueState(choices.map(choice => ({ ...choice, id: choice.id ?? choice.category })), { stateId, status })
  const currentId = current ? current.id : null
  const name = current ? issueStateLabel(current, categoryLabel) : status
  const { open: openStates, closed } = groupIssueStates(filterIssueStates(choices, query, categoryLabel))
  const ordered = [...openStates, ...closed]
  const keyOf = (choice: Choice) => choice.id ?? choice.category
  function select(choice: Choice) {
    setOpen(false); setQuery('')
    if (keyOf(choice) === currentId && choice.category === status) return
    void onChange(choice.category, choice.id)
  }
  const row = (choice: Choice) => {
    const index = ordered.indexOf(choice)
    return { key: keyOf(choice), text: issueStateLabel(choice, categoryLabel), shortcut: !query && index < 9 ? index + 1 : null, checked: keyOf(choice) === currentId }
  }
  const mark = current ? <Mark shape={current.icon} tone={current.color} /> : null
  const aria = tCommon('propertyValue', { label, value: name })
  return <Popover open={open} onOpenChange={value => { setOpen(value); setQuery('') }}>
    {variant === 'icon'
      ? <PopoverTrigger render={<Button type="button" variant="ghost" size="icon-xs" disabled={disabled} className="size-5 rounded-sm text-muted-foreground" title={name} aria-label={aria} data-issue-state-trigger />}>{trigger ?? mark}</PopoverTrigger>
      : <PopoverTrigger render={<Button type="button" variant="ghost" size="sm" disabled={disabled} className={ROW_VALUE} aria-label={aria} data-issue-state-trigger />}>{trigger ?? mark}<span className="truncate">{name}</span></PopoverTrigger>}
    <PopoverContent align="start" className="w-60 p-0" onClick={event => event.stopPropagation()}>
      <Command shouldFilter={false} onKeyDownCapture={event => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || query || disabled) return
        if (!/^[1-9]$/.test(event.key)) return
        const choice = ordered[Number(event.key) - 1]
        if (!choice) return
        event.preventDefault(); event.stopPropagation()
        select(choice)
      }}>
        <CommandInput placeholder={t('search')} aria-label={t('searchAria', { label })} value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>{error && !states ? t('readFailed') : t('noMatch')}</CommandEmpty>
          {([['open', openStates], ['closed', closed]] as const).map(([type, group]) => group.length > 0 && <CommandGroup key={type} heading={t(type)}>
            {group.map(choice => { const view = row(choice); return <CommandItem key={view.key} value={`${view.text} ${view.key}`} disabled={disabled} onSelect={() => select(choice)}>
              <Mark shape={choice.icon} tone={choice.color} />
              <span className="flex-1 truncate">{view.text}</span>
              {view.checked && <Check aria-label={tCommon('selected')} />}
              {view.shortcut && <CommandShortcut>{view.shortcut}</CommandShortcut>}
            </CommandItem> })}
          </CommandGroup>)}
        </CommandList>
      </Command>
    </PopoverContent>
  </Popover>
}
