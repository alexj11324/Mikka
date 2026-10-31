'use client'

import { useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { BOT_NAME_MAX } from '@/lib/bot-shapes'
import { useActionError } from '@/lib/use-action-error'
import { useSaveBot } from './use-save-bot'

/**
 * A bot's name in the right panel, renamed in place (Linear / Notion): click it
 * or press Enter on it to edit; Enter or leaving the field saves, Esc cancels.
 * The new name shows at once everywhere that reads `bots` (bot list, chat
 * title, this panel) and rolls back if the save fails.
 */
export function BotNameEditor({ botId, name }: { botId: string; name: string }) {
  const t = useTranslations('Shell.panel')
  const tBot = useTranslations('Shell.newBot')
  const actionError = useActionError()
  const saveBot = useSaveBot()
  /** The text being edited; null when not editing. */
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Enter or Esc already closed the field; the blur that follows must not save again.
  const closed = useRef(false)
  const nameButton = useRef<HTMLButtonElement>(null)
  const hintId = useId()
  const errorId = useId()

  function open() {
    closed.current = false
    setError(null)
    setDraft(name)
  }

  /** Back to the name. Keyboard closes keep focus on it; a click elsewhere leaves focus where it went. */
  function close(refocus: boolean) {
    closed.current = true
    setDraft(null)
    setError(null)
    if (refocus) requestAnimationFrame(() => nameButton.current?.focus())
  }

  async function save(refocus: boolean) {
    if (draft === null || closed.current) return
    const next = draft.trim()
    if (next === name) return close(refocus)
    if (!next) return setError(t('nameRequired'))
    if (next.length > BOT_NAME_MAX) return setError(t('nameTooLong', { max: BOT_NAME_MAX }))
    close(refocus)
    try {
      await saveBot(botId, { name: next })
    } catch (failure) {
      // The old name is back; reopen the field with what was typed and say why it did not save.
      closed.current = false
      setDraft(next)
      setError(actionError(failure instanceof Error ? failure.message : null))
    }
  }

  if (draft === null) {
    return <>
      <h2 className="flex max-w-full justify-center text-xl font-semibold">
        <Button ref={nameButton} variant="ghost" aria-describedby={hintId} onClick={open}
          className="h-auto max-w-full cursor-text justify-center rounded-lg px-2 py-0 text-xl font-semibold">
          <span className="truncate">{name}</span>
        </Button>
      </h2>
      <span id={hintId} className="sr-only">{t('rename')}</span>
    </>
  }

  return <div className="flex w-full flex-col items-center gap-1">
    <Input autoFocus aria-label={tBot('name')} value={draft} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
      className="h-7 rounded-lg px-2 text-center text-xl! font-semibold"
      onFocus={event => event.currentTarget.select()}
      onChange={event => { setDraft(event.target.value); setError(null) }}
      onBlur={() => { void save(false) }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return
        if (event.key === 'Enter') { event.preventDefault(); void save(true) }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true) }
      }} />
    {error && <p id={errorId} role="alert" className="text-xs text-destructive">{error}</p>}
  </div>
}
