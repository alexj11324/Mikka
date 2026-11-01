'use client'

import { Children, isValidElement, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps, type ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useTranslations } from 'next-intl'
import { Copy, TextQuote } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent } from '@/components/ui/popover'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { markdownDiff, remarkDiff } from '@/lib/artifacts/diff'
import { remarkMarks, type TextMark } from '@/lib/artifacts/marks'
import type { ArtifactVersionInfo } from '@/lib/artifacts/types'
import { ArtifactAuthorAvatar } from './artifact-card'

// A Markdown artifact as a page: title, who and when, then the body. Raw
// HTML in the Markdown stays text (react-markdown never renders it) and links
// open outside. Selecting text offers 引用 and 复制; quoted text is marked by
// remarkMarks, so React renders the underline like any other node.

const SAFE_URL = /^(?:https?:|mailto:|#)/i
const SAFE_IMAGE = /^(?:https:|data:image\/(?:png|jpe?g|gif|webp);)/i

function plain(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? plain(child.props.children) : '').join('')
}

const components = (title: string): Components => ({
  // The page already shows the title; a first heading repeating it is dropped.
  h1: ({ children }) => plain(children).trim() === title.trim() ? null : <h2 className="mt-8 mb-2 text-base leading-snug font-semibold text-foreground">{children}</h2>,
  h2: ({ children }) => <h2 className="mt-8 mb-2 text-base leading-snug font-semibold text-foreground">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-6 mb-2 text-sm leading-relaxed font-semibold text-foreground">{children}</h3>,
  h4: ({ children }) => <h4 className="mt-5 mb-1 text-sm leading-relaxed font-semibold text-foreground">{children}</h4>,
  p: ({ children }) => <p className="my-2 text-sm leading-relaxed text-foreground">{children}</p>,
  ul: ({ children }) => <ul className="my-2 flex list-disc flex-col gap-1 pl-5 text-sm leading-relaxed marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 flex list-decimal flex-col gap-1 pl-5 text-sm leading-relaxed marker:text-muted-foreground">{children}</ol>,
  blockquote: ({ children }) => <blockquote className="my-3 rounded-lg bg-muted/50 px-3 py-1 text-muted-foreground">{children}</blockquote>,
  // No rules across the page (R-31): a break is space.
  hr: () => <div role="separator" className="h-6" />,
  a: ({ href, children }) => href && SAFE_URL.test(href) ? <a href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer nofollow" className="text-sidebar-primary underline-offset-4 hover:underline">{children}</a> : <span>{children}</span>,
  img: ({ src, alt }) => typeof src === 'string' && SAFE_IMAGE.test(src) ? <img src={src} alt={alt ?? ''} referrerPolicy="no-referrer" loading="lazy" className="my-3 max-w-full rounded-xl" /> : null,
  code: ({ className, children }) => className ? <code>{children}</code> : <code className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs">{children}</code>,
  pre: ({ children }) => <pre className="my-3 overflow-x-auto rounded-xl bg-muted p-4 font-mono text-xs leading-5 [&_code]:bg-transparent [&_code]:p-0">{children}</pre>,
  table: ({ children }) => <div className="my-3 overflow-hidden rounded-xl bg-muted/40"><Table className="text-sm">{children}</Table></div>,
  thead: ({ children }) => <TableHeader className="bg-muted [&_tr]:border-0">{children}</TableHeader>,
  tbody: ({ children }) => <TableBody>{children}</TableBody>,
  tr: ({ children }) => <TableRow className="hover:bg-transparent">{children}</TableRow>,
  th: ({ children }) => <TableHead className="h-9 px-4 text-xs font-normal text-muted-foreground">{children}</TableHead>,
  td: ({ children }) => <TableCell className="h-11 px-4 text-sm whitespace-normal text-foreground">{children}</TableCell>,
  del: ({ children }) => <del className="rounded-sm text-muted-foreground decoration-muted-foreground/70">{children}</del>,
  ins: ({ children }) => <ins className="rounded-sm bg-success/15 px-0.5 no-underline">{children}</ins>,
  span: ({ children, ...props }) => {
    const mark = (props as Record<string, unknown>)['data-mark']
    if (mark === 'quoting') return <span data-mark="quoting" className="rounded-sm bg-sidebar-primary/15">{children}</span>
    if (mark === 'quoted') return <span data-mark="quoted" className="underline decoration-sidebar-primary decoration-2 underline-offset-4">{children}</span>
    return <span>{children}</span>
  },
} as Components)

/** Where the selection sits on screen, read when the toolbar positions itself. */
function selectionAnchor(range: Range) {
  return { getBoundingClientRect: () => range.getBoundingClientRect() }
}

export function ArtifactDocument({ title, markdown, compareWith, author, meta, quoted, quoting, onQuote }: {
  title: string
  markdown: string
  /** The newer version's text: when given, its changes are marked into this one. */
  compareWith?: string | null
  author: Pick<ArtifactVersionInfo, 'authorName' | 'authorColor' | 'authorShape' | 'authorHarness'>
  /** 「Mikka Frontend · 10月24日 17:20 更新」 */
  meta: string
  /** Texts already quoted from this version, underlined. */
  quoted: readonly string[]
  /** The text being quoted in the composer right now, tinted. */
  quoting: string | null
  /** Without it (the share page) selecting text offers nothing. */
  onQuote?: (text: string) => void
}) {
  const t = useTranslations('Artifact')
  const articleRef = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<{ text: string; range: Range } | null>(null)
  const source = useMemo(() => compareWith != null ? markdownDiff(markdown, compareWith) : markdown, [markdown, compareWith])
  const parts = useMemo(() => components(title), [title])
  const plugins = useMemo<NonNullable<ComponentProps<typeof Markdown>['remarkPlugins']>>(() => {
    const marks: TextMark[] = [...quoted.map(text => ({ text, kind: 'quoted' as const })), ...(quoting ? [{ text: quoting, kind: 'quoting' as const }] : [])]
    return [remarkGfm, ...(compareWith != null ? [remarkDiff] : []), [remarkMarks, marks]]
  }, [compareWith, quoted, quoting])

  const readSelection = useCallback(() => {
    const current = window.getSelection()
    const article = articleRef.current
    if (!current || current.isCollapsed || !article || !current.rangeCount) { setSelection(null); return }
    const range = current.getRangeAt(0)
    if (!article.contains(range.commonAncestorContainer)) { setSelection(null); return }
    const text = current.toString().replace(/\s+/g, ' ').trim()
    setSelection(text ? { text, range: range.cloneRange() } : null)
  }, [])

  useEffect(() => {
    const clear = () => { if (window.getSelection()?.isCollapsed) setSelection(null) }
    document.addEventListener('selectionchange', clear)
    return () => document.removeEventListener('selectionchange', clear)
  }, [])

  function quote() {
    if (!selection) return
    onQuote?.(selection.text)
    window.getSelection()?.removeAllRanges()
    setSelection(null)
  }
  async function copy() {
    if (!selection) return
    try { await navigator.clipboard.writeText(selection.text); toast.success(t('copied')) } catch { /* the browser refused; nothing to undo */ }
    setSelection(null)
  }

  return <div className="min-h-0 flex-1 overflow-y-auto" onMouseUp={readSelection} onKeyUp={readSelection}>
    <article className="mx-auto w-full max-w-[40rem] px-6 pt-10 pb-16 md:px-10">
      <h1 className="text-xl leading-7 font-semibold text-foreground">{title}</h1>
      <p className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">{author.authorName && <ArtifactAuthorAvatar author={author} />}{meta}</p>
      <div ref={articleRef} data-slot="artifact-document" className="mt-4">
        <Markdown remarkPlugins={plugins} components={parts}>{source}</Markdown>
      </div>
    </article>
    {onQuote && <Popover open={selection != null} onOpenChange={open => { if (!open) setSelection(null) }}>
      {selection && <PopoverContent anchor={selectionAnchor(selection.range)} side="top" sideOffset={8} initialFocus={false} finalFocus={false} aria-label={t('quote')}
        className="w-auto flex-row gap-0.5 p-1" onMouseUp={event => event.stopPropagation()}>
        <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={quote}><TextQuote data-icon="inline-start" />{t('quote')}</Button>
        <Button size="sm" variant="ghost" onMouseDown={event => event.preventDefault()} onClick={() => void copy()}><Copy data-icon="inline-start" />{t('copy')}</Button>
      </PopoverContent>}
    </Popover>}
  </div>
}
