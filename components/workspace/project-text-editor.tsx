'use client'

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { FieldError } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { readProjectDescription } from '@/lib/project-description'
import { IssueEditor } from './issue-editor'

type TextField = 'name' | 'description'
const FIELD_OPTIONS = {
  name: { maxLength: 200 },
  description: { maxLength: 50000 },
}

export function ProjectTextEditor({ field, value, onSave, onRegisterFlush }: { field: TextField; value: string; onSave: (value: string) => Promise<boolean>; onRegisterFlush: (flush: (() => Promise<boolean>) | null) => void }) {
  const t = useTranslations('Projects.textEditor')
  const id = useId()
  const label = field === 'name' ? t('nameLabel') : t('descriptionLabel')
  const placeholder = field === 'name' ? t('namePlaceholder') : t('descriptionPlaceholder')
  const [draft, setDraft] = useState(value)
  const [initialContent] = useState(() => readProjectDescription(value))
  const [replacement, setReplacement] = useState<{ content: ReturnType<typeof readProjectDescription>; version: number }>()
  const [hasChanges, setHasChanges] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editSequence, setEditSequence] = useState(0)
  const latest = useRef(value)
  const textElement = useRef<HTMLSpanElement | null>(null)
  const attachText = useCallback((element: HTMLSpanElement | null) => {
    textElement.current = element
    if (element) element.textContent = latest.current
  }, [])
  const TextContainer = field === 'name' ? 'h1' : 'p'
  const acknowledged = useRef(value)
  const dirty = useRef(false)
  const composing = useRef(false)
  const flight = useRef<Promise<boolean> | null>(null)
  const saveRef = useRef(onSave)
  saveRef.current = onSave

  useEffect(() => {
    if (dirty.current || acknowledged.current === value) return
    latest.current = value
    acknowledged.current = value
    setDraft(value)
    if (textElement.current) textElement.current.textContent = value
    if (field === 'description') setReplacement(current => ({ content: readProjectDescription(value), version: (current?.version ?? 0) + 1 }))
  }, [field, value])

  const save = useCallback((): Promise<boolean> => {
    if (flight.current) return flight.current
    if (composing.current) return Promise.resolve(false)
    if (!dirty.current) return Promise.resolve(true)
    const operation = (async () => {
      setSaving(true)
      setError('')
      try {
        do {
          const next = field === 'description' ? latest.current : latest.current.trim()
          if (field === 'name' && !next) { setError(t('nameRequired')); return false }
          if (next.length > FIELD_OPTIONS[field].maxLength) { setError(t('tooLong')); return false }
          if (next !== acknowledged.current && !await saveRef.current(next)) { setError(t('autosaveFailed')); return false }
          acknowledged.current = next
          dirty.current = (field === 'description' ? latest.current : latest.current.trim()) !== next
          setHasChanges(dirty.current)
        } while (dirty.current && !composing.current)
        return !dirty.current
      } catch {
        setError(t('autosaveFailed'))
        return false
      } finally { setSaving(false) }
    })()
    flight.current = operation
    void operation.finally(() => { flight.current = null })
    return operation
  }, [field, t])

  useEffect(() => {
    onRegisterFlush(save)
    return () => onRegisterFlush(null)
  }, [onRegisterFlush, save])

  useEffect(() => {
    if (!hasChanges || composing.current) return
    const timer = setTimeout(() => { void save() }, 700)
    return () => clearTimeout(timer)
  }, [hasChanges, draft, editSequence, save])

  useEffect(() => {
    if (!hasChanges) return
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault() }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [hasChanges])

  function change(next: string) {
    latest.current = next
    dirty.current = next !== acknowledged.current
    setDraft(next)
    setHasChanges(dirty.current)
    setError('')
  }

  return <div className="w-full min-w-0" onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) void save() }} onCompositionStart={() => { composing.current = true }} onCompositionEnd={() => { composing.current = false; setEditSequence(current => current + 1) }} onKeyDown={event => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    if (event.key === 'Enter' && (field !== 'description' || event.metaKey || event.ctrlKey)) { event.preventDefault(); void save() }
    if (event.key === 'Escape' && field !== 'description' && !flight.current) { event.preventDefault(); event.stopPropagation(); latest.current = acknowledged.current; dirty.current = false; setDraft(acknowledged.current); if (textElement.current) textElement.current.textContent = acknowledged.current; setHasChanges(false); setError('') }
  }}>
    {field === 'description' ? <IssueEditor layout="description" label={label} content={initialContent} replacement={replacement} onChange={content => change(JSON.stringify(content))} /> : <TextContainer className={cn('text-sm leading-relaxed', field === 'name' && 'text-2xl leading-snug font-semibold tracking-tight')}>
      <span ref={attachText} id={id} contentEditable="plaintext-only" suppressContentEditableWarning role="textbox" aria-label={label} aria-multiline="false" aria-required={field === 'name'} aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} aria-placeholder={placeholder} data-placeholder={placeholder} onInput={event => change(event.currentTarget.textContent ?? '')} className="block min-h-8 w-full cursor-text whitespace-pre-wrap break-words outline-none empty:before:text-muted-foreground empty:before:content-[attr(data-placeholder)] focus-visible:underline focus-visible:decoration-muted-foreground/50 focus-visible:underline-offset-4" />
    </TextContainer>}
    {error ? <FieldError id={`${id}-error`} className="mt-2">{error}</FieldError> : (hasChanges || saving) && <p role="status" className="mt-2 text-xs text-muted-foreground">{saving ? t('saving') : t('waiting')}</p>}
  </div>
}
