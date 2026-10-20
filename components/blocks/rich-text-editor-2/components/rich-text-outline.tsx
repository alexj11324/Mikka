import {
  useEffect,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type RefObject,
} from "react"
import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import type { Transaction } from "@tiptap/pm/state"
import type { Editor } from "@tiptap/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"

import { useRichTextSelector } from "./rich-text-state"

export interface RichTextOutlineEntry {
  id: string
  text: string
  level: number
  /** Nesting under the shallowest heading on the page: 0, 1 or 2. */
  depth: number
}

/** Positions of the headings the outline lists, in document order. */
function headingPositions(doc: ProseMirrorNode) {
  const positions: number[] = []

  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return true
    if (node.textContent.trim()) positions.push(pos)
    return false
  })

  return positions
}

function readOutline(editor: Editor | null): RichTextOutlineEntry[] {
  if (!editor) return []

  const { doc } = editor.state
  const headings = headingPositions(doc).map((pos) => {
    const node = doc.nodeAt(pos)
    return {
      text: node?.textContent.trim() ?? "",
      level: Number(node?.attrs.level ?? 1),
    }
  })
  const top = Math.min(...headings.map((heading) => heading.level))

  return headings.map((heading, index) => ({
    id: `${index}-${heading.text}`,
    text: heading.text,
    level: heading.level,
    depth: Math.min(heading.level - top, 2),
  }))
}

/** The page's headings as plain values, so typing elsewhere re-renders nothing. */
export function useRichTextOutline(editor: Editor | null) {
  return useRichTextSelector(editor, readOutline)
}

// Rides on a jump's transaction, so the outline marks the heading that was picked.
const PICKED_HEADING = "richTextPickedHeading"

/** The nearest ancestor that scrolls, or null when the document itself does
 * (body's overflow belongs to the viewport, so the walk stops there). */
function scrollArea(node: HTMLElement) {
  for (
    let parent = node.parentElement;
    parent && parent !== document.body;
    parent = parent.parentElement
  ) {
    if (/auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent
  }
  return null
}

/** Top, height and scroll offsets of a scroll area, the window standing in for null. */
function areaMetrics(area: HTMLElement | null) {
  if (area) {
    return {
      top: area.getBoundingClientRect().top,
      height: area.clientHeight,
      scrollTop: area.scrollTop,
      scrollHeight: area.scrollHeight,
    }
  }
  return {
    top: 0,
    height: window.innerHeight,
    scrollTop: window.scrollY,
    scrollHeight: document.documentElement.scrollHeight,
  }
}

/** Puts the caret at a heading and brings it to the top of its scroll area. */
export function scrollToRichTextHeading(editor: Editor, index: number) {
  const pos = headingPositions(editor.state.doc)[index]

  if (pos === undefined) return

  const dom = editor.view.nodeDOM(pos)
  const reduceMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches

  editor
    .chain()
    .setTextSelection(pos + 1)
    .setMeta(PICKED_HEADING, index)
    .focus(undefined, { scrollIntoView: false })
    .run()

  if (!(dom instanceof HTMLElement)) return

  // scroll-margin-top keeps the heading clear of a sticky header above it.
  const area = scrollArea(dom)
  const { top, scrollTop } = areaMetrics(area)
  const margin = parseFloat(getComputedStyle(dom).scrollMarginTop) || 0

  ;(area ?? window).scrollTo({
    top: scrollTop + dom.getBoundingClientRect().top - top - margin,
    behavior: reduceMotion ? "auto" : "smooth",
  })
}

// A heading counts as current once it rises into the top third of the view.
const ACTIVE_LINE = 0.3

// Input that scrolls by hand, which hands the mark back to the scroll position.
const MANUAL_SCROLL = ["wheel", "touchmove", "keydown", "pointerdown"] as const

/** The heading being read: a picked one until the reader scrolls, else the last
 * one past the line, or the last one at the end. `pageRef` sits inside the
 * scrolling area: a scroller of its own, a host pane, or the window. */
export function useRichTextActiveHeading(
  editor: Editor | null,
  pageRef: RefObject<HTMLElement | null>,
  outline: RichTextOutlineEntry[]
) {
  const [active, setActive] = useState(0)

  useEffect(() => {
    const page = pageRef.current

    if (!editor || !page || outline.length === 0) return

    const area = scrollArea(page)
    const target: EventTarget = area ?? window
    let picked: number | null = null

    function measure() {
      if (!editor) return
      if (picked !== null) {
        setActive(picked)
        return
      }

      const view = areaMetrics(area)
      const line = view.top + view.height * ACTIVE_LINE
      const positions = headingPositions(editor.state.doc)
      const atEnd =
        view.scrollTop > 0 &&
        view.scrollTop + view.height >= view.scrollHeight - 2
      let next = 0

      positions.forEach((pos, index) => {
        const dom = editor.view.nodeDOM(pos)
        if (
          dom instanceof HTMLElement &&
          dom.getBoundingClientRect().top <= line
        ) {
          next = index
        }
      })

      setActive(atEnd ? positions.length - 1 : next)
    }

    function release() {
      picked = null
    }

    function handleTransaction({ transaction }: { transaction: Transaction }) {
      const index: unknown = transaction.getMeta(PICKED_HEADING)

      if (typeof index !== "number") return
      picked = index
      setActive(index)
    }

    // Node views, fonts and width toggles move the headings after mount, so
    // the first read and every later one come from the observer.
    const observer = new ResizeObserver(measure)
    observer.observe(page)
    observer.observe(editor.view.dom)
    target.addEventListener("scroll", measure, { passive: true })
    for (const type of MANUAL_SCROLL) {
      target.addEventListener(type, release, { passive: true })
    }
    editor.on("transaction", handleTransaction)

    return () => {
      observer.disconnect()
      target.removeEventListener("scroll", measure)
      for (const type of MANUAL_SCROLL) {
        target.removeEventListener(type, release)
      }
      editor.off("transaction", handleTransaction)
    }
  }, [editor, pageRef, outline])

  return outline.length ? Math.min(active, outline.length - 1) : -1
}

// One 8px step per heading level, on top of the row's own inset.
const LIST_INDENT = ["", "ps-4", "ps-6"] as const

interface RichTextOutlineListProps {
  outline: RichTextOutlineEntry[]
  activeIndex: number
  onSelect: (index: number) => void
  className?: string
}

/** Arrows wrap at the ends; Home and End jump. */
function stepFrom(key: string, current: number, last: number) {
  switch (key) {
    case "ArrowDown":
      return current === last ? 0 : current + 1
    case "ArrowUp":
      return current === 0 ? last : current - 1
    case "Home":
      return 0
    case "End":
      return last
    default:
      return null
  }
}

/** One ghost row per heading, indented by depth; the current one is filled.
 * One tab stop for the list, on the current heading; arrows move inside it. */
export function RichTextOutlineList({
  outline,
  activeIndex,
  onSelect,
  className,
}: RichTextOutlineListProps) {
  const [focused, setFocused] = useState<number | null>(null)
  const stop = Math.min(focused ?? Math.max(activeIndex, 0), outline.length - 1)

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const rows = Array.from(event.currentTarget.querySelectorAll("button"))
    const current =
      event.target instanceof HTMLButtonElement
        ? rows.indexOf(event.target)
        : -1
    const next =
      current === -1 ? null : stepFrom(event.key, current, rows.length - 1)

    if (next === null) return
    event.preventDefault()
    rows[next]?.focus()
  }

  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null)
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      onBlur={handleBlur}
      className={cn("flex flex-col", className)}
    >
      {outline.map((entry, index) => (
        <Button
          key={entry.id}
          variant="ghost"
          size="xs"
          tabIndex={index === stop ? 0 : -1}
          aria-current={index === activeIndex ? "location" : undefined}
          onFocus={() => setFocused(index)}
          onClick={() => onSelect(index)}
          className={cn(
            "text-muted-foreground aria-[current=location]:bg-muted aria-[current=location]:text-foreground dark:aria-[current=location]:bg-muted/50 w-full justify-start font-normal aria-[current=location]:font-medium",
            LIST_INDENT[entry.depth]
          )}
        >
          <span className="truncate">{entry.text}</span>
        </Button>
      ))}
    </div>
  )
}

// Deeper headings draw shorter dashes; the current one reaches one step further.
// Lengths are a scale of one w-6 bar, so a change animates on transform.
const DASH_SCALE = ["scale-x-67", "scale-x-50", "scale-x-33"] as const
const DASH_ACTIVE_SCALE = ["scale-x-100", "scale-x-83", "scale-x-67"] as const

interface RichTextOutlineRailProps extends RichTextOutlineListProps {
  label?: string
}

/** A quiet dash per heading that opens into the full outline on hover or focus. */
export function RichTextOutlineRail({
  outline,
  activeIndex,
  onSelect,
  label = "Outline",
  className,
}: RichTextOutlineRailProps) {
  if (outline.length === 0) return null

  return (
    <nav aria-label={label} className={cn("group/outline", className)}>
      <div
        aria-hidden="true"
        className="flex w-10 flex-col items-end gap-2.5 py-3 pe-1 transition-opacity duration-150 group-focus-within/outline:opacity-0 group-hover/outline:opacity-0 motion-reduce:transition-none"
      >
        {outline.map((entry, index) => (
          <span
            key={entry.id}
            className={cn(
              "h-0.5 w-6 origin-right rounded-full transition duration-200 ease-out motion-reduce:transition-none rtl:origin-left",
              index === activeIndex
                ? cn("bg-foreground", DASH_ACTIVE_SCALE[entry.depth])
                : cn("bg-muted-foreground/40", DASH_SCALE[entry.depth])
            )}
          />
        ))}
      </div>
      {/* Keeps its one tab stop while hidden, so a keyboard user opens it by focus.
          The inset is menu-tight, so the rows sit close to the card edge. */}
      <Card
        size="sm"
        className="pointer-events-none absolute end-0 top-0 w-56 opacity-0 transition-opacity duration-150 [--card-spacing:--spacing(1)] group-focus-within/outline:pointer-events-auto group-focus-within/outline:opacity-100 group-hover/outline:pointer-events-auto group-hover/outline:opacity-100 motion-reduce:transition-none"
      >
        <CardContent>
          <RichTextOutlineList
            outline={outline}
            activeIndex={activeIndex}
            onSelect={onSelect}
            className="no-scrollbar supports-[animation-timeline:scroll()]:scroll-fade-y max-h-80 overflow-y-auto p-0.5"
          />
        </CardContent>
      </Card>
    </nav>
  )
}