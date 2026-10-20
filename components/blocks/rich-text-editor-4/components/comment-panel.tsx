import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react"
import { Badge } from "@/components/reui/badge"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CommentThread, DraftThread } from "./comment-thread"
import type { ThreadRecord } from "./rich-text-comments"
import { CheckCheckIcon, XIcon } from "lucide-react"

export interface OpenThread {
  thread: ThreadRecord
  /** Null once a teammate deleted the anchored text. */
  excerpt: string | null
}

export interface CommentDraft {
  excerpt: string
  /** Where the draft row sits among the open threads. */
  index: number
}

export interface CommentPanelProps {
  threads: OpenThread[]
  activeId: string | null
  draft: CommentDraft | null
  /** Thread id to the first names replying there right now. */
  replying: Record<string, string[]>
  onSelect: (id: string) => void
  onResolve: (id: string) => void
  onReply: (id: string, body: string) => void
  onDraftSubmit: (body: string) => void
  onDraftCancel: () => void
  draftFieldRef: RefObject<HTMLTextAreaElement | null>
  /** Inside the Sheet: rows carry the gutter and a close button joins the header. */
  onClose?: () => void
  /** The heading takes focus when the Sheet opens or the last row resolves. */
  headingRef?: RefObject<HTMLHeadingElement | null>
  className?: string
}

/** The comment margin: open threads in document order, a draft in its place. */
export function CommentPanel({
  threads,
  activeId,
  draft,
  replying,
  onSelect,
  onResolve,
  onReply,
  onDraftSubmit,
  onDraftCancel,
  draftFieldRef,
  onClose,
  headingRef,
  className,
}: CommentPanelProps) {
  const headingId = useId()
  const ownHeadingRef = useRef<HTMLHeadingElement>(null)
  const heading = headingRef ?? ownHeadingRef
  const sectionRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The row that inherits focus once a resolved row leaves the list.
  const focusAfterResolve = useRef<{ id: string | null } | null>(null)
  const scrollTarget = draft ? "draft" : activeId

  // Keeps the current row in view inside the panel's own scroller, without
  // scrolling the page the way scrollIntoView would.
  useEffect(() => {
    const list = listRef.current
    if (!list || !scrollTarget) return

    const row = list.querySelector<HTMLElement>(
      `[data-thread-id="${CSS.escape(scrollTarget)}"]`
    )
    if (!row) return

    const rowBox = row.getBoundingClientRect()
    const listBox = list.getBoundingClientRect()

    if (rowBox.top < listBox.top) {
      list.scrollTop -= listBox.top - rowBox.top
    } else if (rowBox.bottom > listBox.bottom) {
      list.scrollTop += rowBox.bottom - listBox.bottom
    }
  }, [scrollTarget])

  // A resolved row unmounts with focus inside it, so focus moves to the next
  // row (the previous one at the end, the heading once the list is empty).
  useLayoutEffect(() => {
    const pending = focusAfterResolve.current
    if (!pending) return
    focusAfterResolve.current = null

    const active = document.activeElement
    const lost = !active || active === document.body
    if (!lost && !sectionRef.current?.contains(active)) return

    const row = pending.id
      ? listRef.current?.querySelector<HTMLElement>(
          `[data-thread-id="${CSS.escape(pending.id)}"] [data-thread-select]`
        )
      : null
    ;(row ?? heading.current)?.focus()
  }, [threads, heading])

  function resolve(id: string) {
    const index = threads.findIndex((item) => item.thread.id === id)
    const next = threads[index + 1] ?? threads[index - 1] ?? null
    focusAfterResolve.current = { id: next?.thread.id ?? null }
    onResolve(id)
  }

  const title = (
    <>
      <h2 ref={heading} id={headingId} tabIndex={-1} className="outline-none">
        Comments
      </h2>
      <Badge variant="outline" className="tabular-nums">
        {threads.length}
      </Badge>
    </>
  )

  const rows: ReactNode[] = threads.map(({ thread, excerpt }) => (
    <CommentThread
      key={thread.id}
      thread={thread}
      excerpt={excerpt}
      current={!draft && thread.id === activeId}
      replying={replying[thread.id] ?? []}
      onSelect={onSelect}
      onResolve={resolve}
      onReply={onReply}
    />
  ))
  if (draft) {
    rows.splice(
      draft.index,
      0,
      <DraftThread
        key="draft"
        excerpt={draft.excerpt}
        fieldRef={draftFieldRef}
        onSubmit={onDraftSubmit}
        onCancel={onDraftCancel}
      />
    )
  }

  const body =
    rows.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CheckCheckIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No Open Comments</EmptyTitle>
          <EmptyDescription>
            Select text and press Comment to start one.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : (
      <div
        ref={listRef}
        className={cn(
          "no-scrollbar supports-[animation-timeline:scroll()]:scroll-fade-y relative min-h-0 overflow-y-auto overscroll-contain",
          onClose && "px-4 pb-4"
        )}
      >
        <ul aria-label="Open comments" className="flex flex-col gap-0.5">
          {rows}
        </ul>
      </div>
    )

  // Inside the Sheet the sheet is the surface, so the panel adds no card.
  if (onClose) {
    return (
      <section
        ref={sectionRef}
        aria-labelledby={headingId}
        className={cn("flex min-h-0 flex-col gap-3", className)}
      >
        <div className="flex min-h-8 shrink-0 items-center gap-2 px-4 text-sm font-medium">
          {title}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Close comments"
                  onClick={onClose}
                  className="ms-auto"
                />
              }
            >
              <XIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>Close</TooltipContent>
          </Tooltip>
        </div>
        {body}
      </section>
    )
  }

  // Sized by its rows up to the margin's cap; only the list scrolls.
  return (
    <Card
      ref={sectionRef}
      size="sm"
      role="region"
      aria-labelledby={headingId}
      className={cn("min-h-0", className)}
    >
      <CardHeader>
        <CardTitle className="flex items-center gap-2">{title}</CardTitle>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-col">{body}</CardContent>
    </Card>
  )
}