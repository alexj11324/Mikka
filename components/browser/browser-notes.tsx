'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { BoxSelect, SquareDashedMousePointer, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { NOTES_MAX, noteChipText, type BrowserNote } from '@/lib/browser/note'

interface BrowserNotes {
  notes: readonly BrowserNote[]
  /** Pins a note; its number is the next one. Ignored when no chat can take it. */
  add: (note: Omit<BrowserNote, 'n'>) => void
  remove: (n: number) => void
  clear: () => void
  /** Whether a chat composer is on screen to take notes. */
  hasComposer: boolean
  /** A chat composer calls this while it is mounted; returns the cleanup. */
  attachComposer: () => () => void
}

const Context = createContext<BrowserNotes | null>(null)

/**
 * The notes pinned in the app-wide browser, waiting in the current chat's
 * composer. The browser column adds them; the chat on screen shows them as
 * chips and sends them with the next message, then clears them.
 */
export function BrowserNotesProvider({ children }: { children: ReactNode }) {
  const [notes, setNotes] = useState<BrowserNote[]>([])
  const [composers, setComposers] = useState(0)
  const add = useCallback((note: Omit<BrowserNote, 'n'>) => setNotes(current => current.length >= NOTES_MAX ? current : [...current, { ...note, n: Math.max(0, ...current.map(item => item.n)) + 1 }]), [])
  const remove = useCallback((n: number) => setNotes(current => current.filter(item => item.n !== n)), [])
  const clear = useCallback(() => setNotes([]), [])
  const attachComposer = useCallback(() => {
    setComposers(count => count + 1)
    return () => setComposers(count => count - 1)
  }, [])
  const value = useMemo(() => ({ notes, add, remove, clear, hasComposer: composers > 0, attachComposer }), [notes, add, remove, clear, composers, attachComposer])
  return <Context value={value}>{children}</Context>
}

/** The browser's notes, or null outside the workspace shell. */
export function useBrowserNotes() {
  return useContext(Context)
}

/** For a chat composer: registers it as where notes go while `active`, and returns the notes. */
export function useBrowserNotesComposer(active: boolean) {
  const context = useContext(Context)
  const attach = context?.attachComposer
  useEffect(() => active && attach ? attach() : undefined, [active, attach])
  return active ? context : null
}

const NoteIcon = ({ kind }: { kind: BrowserNote['kind'] }) => kind === 'element'
  ? <SquareDashedMousePointer aria-hidden="true" className="size-3.5 shrink-0" />
  : <BoxSelect aria-hidden="true" className="size-3.5 shrink-0" />

/** One note waiting in the composer: 「1 · 按钮 · 删除 · 删了，刷新又回来了」 and ✕ (Figma 412:8066). */
export function BrowserNoteChip({ note, onRemove }: { note: BrowserNote; onRemove: () => void }) {
  const t = useTranslations('Browser')
  const words = noteChipText(note)
  return <div data-slot="browser-note-chip" className="flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md pr-0.5 pl-2 text-xs text-sidebar-primary">
    <NoteIcon kind={note.kind} />
    <span className="min-w-0 truncate" title={`${words}\n${note.url}`}>{words}</span>
    <Button type="button" variant="ghost" size="icon-xs" className="text-sidebar-primary hover:text-sidebar-primary" aria-label={t('removeNote', { n: note.n })} onClick={onRemove}><X data-icon="inline-start" /></Button>
  </div>
}

/** A note at the top of a sent message. */
export function BrowserNoteLine({ note }: { note: BrowserNote }) {
  const words = noteChipText(note)
  return <span data-slot="browser-note" title={note.url} className="flex min-w-0 items-center gap-1.5 border-l-2 border-current/30 pl-2 text-xs opacity-85">
    <NoteIcon kind={note.kind} />
    <span className="truncate">{words}</span>
  </span>
}
