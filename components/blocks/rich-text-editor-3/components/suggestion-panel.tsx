import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type RefObject,
} from "react"
import { Badge } from "@/components/reui/badge"
import type { Editor } from "@tiptap/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  useRichTextChanges,
  type RichTextMarkupView,
  type SuggestionResolution,
} from "./rich-text-changes"
import { SuggestionRow } from "./suggestion-row"
import { MoreHorizontalIcon, CheckCheckIcon, CircleXIcon, XIcon } from "lucide-react"

const MARKUP_VIEWS: { value: RichTextMarkupView; label: string }[] = [
  { value: "all", label: "All markup" },
  { value: "final", label: "Final" },
  { value: "original", label: "Original" },
]

function isMarkupView(value: unknown): value is RichTextMarkupView {
  return MARKUP_VIEWS.some((view) => view.value === value)
}

export interface SuggestionPanelProps {
  editor: Editor | null
  canResolve: boolean
  markup: RichTextMarkupView
  onMarkupChange: (markup: RichTextMarkupView) => void
  onSelect: (id: string) => void
  onResolve: (id: string, resolution: SuggestionResolution) => void
  onResolveAll: (resolution: SuggestionResolution) => void
  /** Mod-Z and Mod-Shift-Z from the list, so a resolve undoes where it ran. */
  onHistory: (step: "undo" | "redo") => void
  /** Inside the Sheet: rows carry the gutter and a close button joins the header. */
  onClose?: () => void
  /** The heading takes focus when the Sheet opens or the last row resolves. */
  headingRef?: RefObject<HTMLHeadingElement | null>
  className?: string
}

function isHistoryKey(event: KeyboardEvent) {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null
  const key = event.key.toLowerCase()
  if (key === "z") return event.shiftKey ? "redo" : "undo"
  if (key === "y" && !event.shiftKey) return "redo"
  return null
}

/** The review margin: markup lens, bulk actions and one row per suggestion. */
export function SuggestionPanel({
  editor,
  canResolve,
  markup,
  onMarkupChange,
  onSelect,
  onResolve,
  onResolveAll,
  onHistory,
  onClose,
  headingRef,
  className,
}: SuggestionPanelProps) {
  const { changes, activeId } = useRichTextChanges(editor)
  const headingId = useId()
  const ownHeadingRef = useRef<HTMLHeadingElement>(null)
  const heading = headingRef ?? ownHeadingRef
  const sectionRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // The row that inherits focus once a resolved row leaves the list.
  const focusAfterResolve = useRef<{ id: string | null } | null>(null)

  // Keeps the row under the caret in view inside the panel's own scroller,
  // without scrolling the page the way scrollIntoView would.
  useEffect(() => {
    const list = listRef.current
    if (!list || !activeId) return

    const row = list.querySelector<HTMLElement>(
      `[data-change-id="${CSS.escape(activeId)}"]`
    )
    if (!row) return

    const rowBox = row.getBoundingClientRect()
    const listBox = list.getBoundingClientRect()

    if (rowBox.top < listBox.top) {
      list.scrollTop -= listBox.top - rowBox.top
    } else if (rowBox.bottom > listBox.bottom) {
      list.scrollTop += rowBox.bottom - listBox.bottom
    }
  }, [activeId])

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
          `[data-change-id="${CSS.escape(pending.id)}"] [data-row-select]`
        )
      : null
    ;(row ?? heading.current)?.focus()
  }, [changes, heading])

  function resolve(id: string, resolution: SuggestionResolution) {
    const index = changes.findIndex((change) => change.id === id)
    const next = changes[index + 1] ?? changes[index - 1] ?? null
    focusAfterResolve.current = { id: next?.id ?? null }
    onResolve(id, resolution)
  }

  function handleKeyDown(event: KeyboardEvent) {
    const step = isHistoryKey(event)
    if (!step || !canResolve) return
    event.preventDefault()
    onHistory(step)
  }

  const title = (
    <>
      <h2 ref={heading} id={headingId} tabIndex={-1} className="outline-none">
        Suggestions
      </h2>
      <Badge variant="outline" className="tabular-nums">
        {changes.length}
      </Badge>
    </>
  )

  const bulkMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Resolve all suggestions"
            disabled={!canResolve || changes.length === 0}
            className={cn(onClose && "ms-auto")}
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>All Suggestions</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onResolveAll("accept")}>
            <CheckCheckIcon aria-hidden="true" />
            Accept All
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            onClick={() => onResolveAll("reject")}
          >
            <CircleXIcon aria-hidden="true" />
            Reject All
          </DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // Nothing left to preview once every suggestion is resolved.
  const markupToggle = (
    <ToggleGroup
      disabled={changes.length === 0}
      multiple={false}
      value={[markup]}
      onValueChange={(value) => {
        // Pressing the active view again keeps it: one lens is always on.
        const next = value[0]
        if (isMarkupView(next)) onMarkupChange(next)
      }}
      variant="outline"
      size="sm"
      spacing={0}
      aria-label="Markup view"
      className="w-full"
    >
      {MARKUP_VIEWS.map((view) => (
        <ToggleGroupItem key={view.value} value={view.value} className="flex-1">
          {view.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )

  const body =
    changes.length === 0 ? (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CheckCheckIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No Open Suggestions</EmptyTitle>
          <EmptyDescription>
            Every suggestion in this draft is resolved.
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
        <ul aria-label="Open suggestions" className="flex flex-col gap-0.5">
          {changes.map((change) => (
            <SuggestionRow
              key={change.id}
              change={change}
              current={change.id === activeId}
              canResolve={canResolve}
              onSelect={onSelect}
              onResolve={resolve}
            />
          ))}
        </ul>
      </div>
    )

  // Inside the Sheet the sheet is the surface, so the panel adds no card.
  if (onClose) {
    return (
      <section
        ref={sectionRef}
        aria-labelledby={headingId}
        onKeyDown={handleKeyDown}
        className={cn("flex min-h-0 flex-col gap-4", className)}
      >
        <div className="flex shrink-0 flex-col gap-3 px-4">
          <div className="flex min-h-8 items-center gap-2 text-sm font-medium">
            {title}
            {bulkMenu}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Close suggestions"
                    onClick={onClose}
                  />
                }
              >
                <XIcon aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent>Close</TooltipContent>
            </Tooltip>
          </div>
          {markupToggle}
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
      onKeyDown={handleKeyDown}
      className={cn("min-h-0", className)}
    >
      {/* One centered row: a two-row action would add an empty row's gap. */}
      <CardHeader className="items-center">
        <CardTitle className="flex items-center gap-2">{title}</CardTitle>
        <CardAction className="row-span-1 self-center">{bulkMenu}</CardAction>
      </CardHeader>
      {/* Rows carry their own top inset, so a short gap centers the toggle
          between the title and the first row. */}
      <CardContent className="flex min-h-0 flex-col gap-1">
        {markupToggle}
        {body}
      </CardContent>
    </Card>
  )
}