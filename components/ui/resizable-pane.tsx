"use client"

import type { ComponentProps, CSSProperties, MouseEvent as ReactMouseEvent } from "react"
import { cn } from "cn"

import { RESIZE_EDGE, useResizableWidth, type ResizableWidth, type ResizableWidthOptions } from "@/hooks/use-resizable-width"

/**
 * The line between two columns, as a handle: drag it, use the arrow keys on it
 * (Shift for bigger steps, Home and End for the limits), or double-click it to
 * go back to the default width. Every vertical divider between columns is one
 * of these (decision 2026-11-01-1310); it sits on the column's own border.
 */
function ResizeHandle({
  resize,
  label,
  edge,
  className,
  onDoubleClick,
  onClick,
  ...props
}: Omit<ComponentProps<"div">, "children"> & {
  resize: ResizableWidth<number | null>
  label: string
  /** The column edge it sits on: "start" for a column on the right, "end" for one on the left. */
  edge: "start" | "end"
}) {
  return (
    <div
      data-slot="resize-handle"
      {...resize.handleProps}
      aria-label={label}
      title={label}
      onDoubleClick={(event: ReactMouseEvent<HTMLDivElement>) => {
        onDoubleClick?.(event)
        if (!event.defaultPrevented) resize.reset()
      }}
      onClick={onClick}
      // A handle that also acts on a click (the bot list folds) does so on Enter too, as a button would.
      onKeyDown={event => {
        resize.handleProps.onKeyDown(event)
        if (onClick && event.key === "Enter") { event.preventDefault(); event.currentTarget.click() }
      }}
      className={cn(RESIZE_EDGE, "absolute inset-y-0", edge === "start" ? "start-0 after:start-0" : "end-0 after:end-0", className)}
      {...props}
    />
  )
}

/** From which width the column sits beside the other one; below it the column keeps its own layout and has no handle. */
const FROM = {
  always: { pane: "data-sized:w-(--pane-width) data-sized:flex-none", handle: "" },
  md: { pane: "md:data-sized:w-(--pane-width) md:data-sized:flex-none", handle: "hidden md:block" },
  lg: { pane: "lg:data-sized:w-(--pane-width) lg:data-sized:flex-none", handle: "hidden lg:block" },
  xl: { pane: "xl:data-sized:w-(--pane-width) xl:data-sized:flex-none", handle: "hidden xl:block" },
} as const

/**
 * A column beside another, resizable from the edge it shares with it. Its width
 * is remembered per `storageKey` on this device, stays between `min` and `max`,
 * and goes back to `defaultWidth` on a double-click. A null `defaultWidth`
 * leaves the width to the column's own classes (a 50/50 split) until the edge
 * is moved. The column keeps its own border: that line is where the handle sits.
 * Anything wider than the column is clipped, so it never scrolls the page sideways.
 */
function ResizablePane({
  storageKey,
  min,
  max,
  defaultWidth = null,
  edge,
  label,
  from = "always",
  render: Element = "div",
  className,
  style,
  children,
  ...props
}: ComponentProps<"div"> & Omit<ResizableWidthOptions, "initial"> & {
  defaultWidth?: number | null
  label: string
  from?: keyof typeof FROM
  render?: "div" | "aside" | "section"
}) {
  const resize = useResizableWidth({ storageKey, min, max, initial: defaultWidth, edge })
  const sized = resize.width !== null
  return (
    <Element
      data-slot="resizable-pane"
      data-sized={sized ? "" : undefined}
      style={sized ? ({ ...style, "--pane-width": `${resize.width}px` } as CSSProperties) : style}
      // A column never widens its neighbour or scrolls the page sideways: what is wider than it is clipped here.
      className={cn("relative min-w-0 overflow-x-clip", FROM[from].pane, resize.dragging && "select-none", className)}
      {...props}
    >
      {children}
      <ResizeHandle resize={resize} label={label} edge={edge} className={FROM[from].handle} />
    </Element>
  )
}

export { ResizablePane, ResizeHandle }
