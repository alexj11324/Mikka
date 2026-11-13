'use client'

import { useEffect, useRef, useState, type RefObject } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { withBasePath } from '@/lib/base-path'
import { mentionAt, personReferenceParts, referenceMarker, referenceQueryReady, type ThreadReference } from '@/lib/thread-references'
import { openTask, openThread, workspaceSearch } from './workspace-navigation'

export function PersonReferences({ text }: { text: string }) {
  const t = useTranslations('ThreadReferences')
  return <>{personReferenceParts(text).map((part, index) => {
    if (part.kind === 'text') return part.text
    if (part.kind === 'pr') return <a key={index} href={part.id} target="_blank" rel="noreferrer" className="break-all underline">{part.id.replace('https://github.com/', '')}</a>
    const task = part.kind === 'task'
    const href = withBasePath('/' + workspaceSearch(task ? { task: part.id } : { thread: part.id }))
    return <a key={index} href={href} className="underline" onClick={event => {
      if (event.button || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      event.preventDefault()
      if (task) openTask(part.id)
      else openThread(part.id)
    }}>{t(part.kind)} {part.id.slice(0, 8)}</a>
  })}</>
}

type Mention = NonNullable<ReturnType<typeof mentionAt>>
type Lookup = { mention: Mention; workspaceId: string; items?: ThreadReference[]; failed?: boolean }

export function ThreadReferencePicker({ draft, workspaceId, input, onChange }: {
  draft: string; workspaceId: string; input: RefObject<HTMLTextAreaElement | null>; onChange: (draft: string) => void
}) {
  const t = useTranslations('ThreadReferences')
  const group = useRef<HTMLDivElement>(null)
  const [caret, setCaret] = useState<number | null>(null)
  const [dismissed, setDismissed] = useState('')
  const [lookup, setLookup] = useState<Lookup | null>(null)
  useEffect(() => {
    const textarea = input.current
    if (!textarea) return
    const select = () => { if (textarea.ownerDocument.activeElement === textarea) update() }
    const update = () => setCaret(textarea.selectionStart)
    update()
    textarea.addEventListener('input', update)
    textarea.ownerDocument.addEventListener('selectionchange', select)
    textarea.addEventListener('click', update)
    textarea.addEventListener('keyup', update)
    return () => {
      textarea.removeEventListener('input', update)
      textarea.ownerDocument.removeEventListener('selectionchange', select)
      textarea.removeEventListener('click', update)
      textarea.removeEventListener('keyup', update)
    }
  }, [input, workspaceId])
  const mention = mentionAt(draft, caret ?? draft.length)
  const from = mention?.from, end = mention?.end, query = mention?.query, kind = mention?.kind
  const signature = JSON.stringify([workspaceId, draft, end])
  const visible = query !== undefined && dismissed !== signature && referenceQueryReady(query)
  useEffect(() => {
    if (!visible || query === undefined || from === undefined || end === undefined) return
    let active = true
    const at = { from, end, query, kind }
    const timer = setTimeout(async () => {
      try {
        const { findThreadReferences } = await import('@/app/actions/task-runs')
        const items = await findThreadReferences(workspaceId, query, kind)
        if (active) setLookup({ mention: at, workspaceId, items })
      } catch { if (active) setLookup({ mention: at, workspaceId, failed: true }) }
    }, 180)
    return () => { active = false; clearTimeout(timer) }
  }, [from, end, query, kind, workspaceId, visible])
  useEffect(() => {
    const textarea = input.current
    if (!visible || !textarea) return
    const key = (event: KeyboardEvent) => {
      if (event.isComposing) return
      if (event.key === 'ArrowDown' && group.current?.querySelector('button')) {
        event.preventDefault(); event.stopPropagation(); group.current.querySelector('button')?.focus()
      } else if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation(); setDismissed(signature)
      }
    }
    textarea.addEventListener('keydown', key, true)
    return () => textarea.removeEventListener('keydown', key, true)
  }, [visible, input, signature])
  if (!visible || !mention) return null
  const current = lookup?.workspaceId === workspaceId && lookup.mention.query === query && lookup.mention.kind === kind &&
    lookup.mention.from === from && lookup.mention.end === end ? lookup : null
  return <div ref={group} role="group" aria-label={t('references')} className="flex max-h-48 flex-col items-start gap-1 overflow-auto rounded-md border bg-background p-2" onKeyDown={event => {
    if (event.key === 'Escape') { event.stopPropagation(); setDismissed(signature); input.current?.focus(); return }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const buttons = Array.from(event.currentTarget.querySelectorAll('button'))
    const index = buttons.indexOf(event.target as HTMLButtonElement)
    const next = index + (event.key === 'ArrowDown' ? 1 : -1)
    event.preventDefault()
    if (next < 0) input.current?.focus()
    else buttons[next]?.focus()
  }}>
    {!current ? <span role="status">{t('searching')}</span> : current.failed ? <span role="alert">{t('error')}</span> :
      !current.items?.length ? <span role="status">{t('empty')}</span> : current.items.map(item =>
        <Button key={`${item.kind}:${item.id}`} type="button" variant="ghost" size="sm" className="w-full justify-start"
          onClick={() => {
            const insert = referenceMarker(item) + ' '
            const next = draft.slice(0, mention.from) + insert + draft.slice(mention.end)
            const position = mention.from + insert.length
            onChange(next)
            requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(position, position) })
          }}><span className="text-muted-foreground">{t(item.kind)}</span><span className="truncate">{item.title}</span></Button>)}
  </div>
}
