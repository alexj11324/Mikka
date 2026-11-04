"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * A vertical lane graph, like `git log --graph`: rows stacked top to bottom,
 * each on a lane, joined by lane lines and by branch lines that leave a lane
 * and bend into the next one. The project map (R-83) draws with it.
 */
export type LaneMarker = "done" | "active" | "idle" | "abandoned" | "fork" | "fold" | "none"
export type LaneLineKind = "main" | "live" | "abandoned" | "highlight"

export interface LaneGraphRow {
  key: string
  lane: number
  height: number
  marker: LaneMarker
  current?: boolean
  /** Gutter text beside the row (a date). */
  label?: string
  labelDateTime?: string
  faded?: boolean
  /** `fill` spans to the right edge (capped); `content` hugs its content. */
  width?: "fill" | "content"
  children: React.ReactNode
}
export interface LaneGraphLine { lane: number; from: number; to: number; kind: LaneLineKind }
export interface LaneGraphBranch { fromLane: number; from: number; toLane: number; to: number; kind: LaneLineKind }
export interface LaneGraphGeometry { lane0: number; step: number; offset: number; right: number; gutter: boolean }

const GAP = 12
const TOP = 20
const MAX_ROW_WIDTH = 760

const LINE_CLASS: Record<LaneLineKind, string> = {
  main: "fill-none stroke-muted-foreground stroke-2",
  live: "fill-none stroke-muted-foreground stroke-[1.5]",
  abandoned: "fill-none stroke-[var(--ink-3)] stroke-[1.5] [stroke-dasharray:4_3]",
  highlight: "fill-none stroke-sidebar-primary stroke-[2.5]",
}

export function laneGraphHeight(rows: readonly Pick<LaneGraphRow, "height">[]) {
  return rows.reduce((sum, row) => sum + row.height + GAP, TOP) + TOP - GAP
}

function rowTops(rows: readonly Pick<LaneGraphRow, "height">[]) {
  const tops: number[] = []
  let y = TOP
  for (const row of rows) { tops.push(y); y += row.height + GAP }
  return tops
}

/** Down the parent's lane, then out to the branch just above its first row. */
function branchPath(x1: number, y1: number, x2: number, y2: number, top: number) {
  const bend = Math.max(y1, top - 18)
  return `M${x1} ${y1} L${x1} ${bend} C${x1} ${bend + 14} ${x2} ${y2 - 14} ${x2} ${y2}`
}

function Marker({ marker, current, x, y }: { marker: LaneMarker; current?: boolean; x: number; y: number }) {
  switch (marker) {
    case "fork": return <path d={`M${x} ${y - 6.5} L${x + 6.5} ${y} L${x} ${y + 6.5} L${x - 6.5} ${y}Z`} className="fill-muted-foreground stroke-shell-panel stroke-[2.5] [stroke-linejoin:round]" />
    case "fold": return <circle cx={x} cy={y} r={4.5} className="fill-shell-panel stroke-[var(--ink-3)] stroke-[1.5]" />
    case "abandoned": return <circle cx={x} cy={y} r={5} className="fill-shell-panel stroke-[var(--ink-3)] stroke-[1.5] [stroke-dasharray:2.4_2]" />
    case "done": return <circle cx={x} cy={y} r={5.5} className="fill-success stroke-shell-panel stroke-[3]" />
    case "active": return <circle cx={x} cy={y} r={current ? 6 : 5} className="fill-shell-panel stroke-warning stroke-2" />
    case "idle": return <circle cx={x} cy={y} r={5} className="fill-shell-panel stroke-muted-foreground stroke-2" />
    default: return null
  }
}

interface LaneGraphProps {
  rows: readonly LaneGraphRow[]
  lanes: readonly LaneGraphLine[]
  branches: readonly LaneGraphBranch[]
  geometry: LaneGraphGeometry
  /** Percent; 100 is the drawn size. */
  zoom?: number
  minimapLabel?: string
  scrollerRef?: React.Ref<HTMLDivElement>
  className?: string
}

export function LaneGraph({ rows, lanes, branches, geometry, zoom = 100, minimapLabel, scrollerRef, className }: LaneGraphProps) {
  const tops = React.useMemo(() => rowTops(rows), [rows])
  const height = laneGraphHeight(rows)
  const laneX = (lane: number) => geometry.lane0 + lane * geometry.step
  const centre = (index: number) => tops[index] + rows[index].height / 2
  const scroller = React.useRef<HTMLDivElement | null>(null)
  const setScroller = (node: HTMLDivElement | null) => {
    scroller.current = node
    if (typeof scrollerRef === "function") scrollerRef(node)
    else if (scrollerRef) (scrollerRef as React.MutableRefObject<HTMLDivElement | null>).current = node
  }
  const line = (item: LaneGraphLine, key: string) => <path key={key} d={`M${laneX(item.lane)} ${centre(item.from)} L${laneX(item.lane)} ${centre(item.to)}`} className={LINE_CLASS[item.kind]} />
  const branch = (item: LaneGraphBranch, key: string) => <path key={key} d={branchPath(laneX(item.fromLane), centre(item.from), laneX(item.toLane), centre(item.to), tops[item.to])} className={LINE_CLASS[item.kind]} />
  const highlight = (kind: LaneLineKind) => kind === "highlight"
  return (
    <div data-slot="lane-graph" className={cn("relative min-h-0 flex-1", className)}>
      <div ref={setScroller} className="absolute inset-0 overflow-auto bg-shell-panel">
        <div className="relative min-w-[22rem]" style={{ height: height * zoom / 100 }}>
          <div className="absolute inset-x-0 top-0" style={{ height, zoom: zoom / 100 }}>
            <svg aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-visible" width="100%" height={height}>
              {lanes.filter(item => !highlight(item.kind)).map((item, index) => line(item, `l${index}`))}
              {branches.filter(item => !highlight(item.kind)).map((item, index) => branch(item, `b${index}`))}
              {lanes.filter(item => highlight(item.kind)).map((item, index) => line(item, `hl${index}`))}
              {branches.filter(item => highlight(item.kind)).map((item, index) => branch(item, `hb${index}`))}
              {rows.map((row, index) => <Marker key={row.key} marker={row.marker} current={row.current} x={laneX(row.lane)} y={centre(index)} />)}
            </svg>
            {rows.map((row, index) => {
              const left = laneX(row.lane) + geometry.offset
              return (
                <React.Fragment key={row.key}>
                  {geometry.gutter && row.label && <time dateTime={row.labelDateTime} className="absolute w-16 text-right text-xs text-muted-foreground/70" style={{ top: centre(index) - 9, left: 8 }}>{row.label}</time>}
                  <div
                    data-row={row.key}
                    className={cn("absolute transition-opacity", row.faded && "opacity-35", row.width === "content" && "flex items-center")}
                    style={row.width === "content"
                      ? { top: tops[index], left, height: row.height, maxWidth: `calc(100% - ${left + geometry.right}px)` }
                      : { top: tops[index], left, height: row.height, width: `min(${MAX_ROW_WIDTH}px, calc(100% - ${left + geometry.right}px))` }}
                  >
                    {row.children}
                  </div>
                </React.Fragment>
              )
            })}
          </div>
        </div>
      </div>
      {minimapLabel && <LaneGraphMinimap rows={rows} tops={tops} height={height} zoom={zoom} scroller={scroller} label={minimapLabel} />}
    </div>
  )
}

function LaneGraphMinimap({ rows, tops, height, zoom, scroller, label }: { rows: readonly LaneGraphRow[]; tops: number[]; height: number; zoom: number; scroller: React.RefObject<HTMLDivElement | null>; label: string }) {
  const [view, setView] = React.useState({ top: 0, height: Infinity })
  const W = 140, H = 92
  const scale = Math.min(1, (H - 8) / height)
  React.useEffect(() => {
    const box = scroller.current
    if (!box) return
    const update = () => setView({ top: box.scrollTop / (zoom / 100), height: box.clientHeight / (zoom / 100) })
    update()
    box.addEventListener("scroll", update, { passive: true })
    window.addEventListener("resize", update)
    return () => { box.removeEventListener("scroll", update); window.removeEventListener("resize", update) }
  }, [scroller, zoom, height])
  if (view.height >= height) return null
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="absolute right-4 bottom-4 rounded-lg bg-card p-1 shadow-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={event => {
        const rect = event.currentTarget.getBoundingClientRect()
        const y = (event.clientY - rect.top - 4) / scale
        scroller.current?.scrollTo({ top: Math.max(0, (y - view.height / 2) * zoom / 100) })
      }}
    >
      <svg width={W} height={H} aria-hidden="true">
        {rows.map((row, index) => row.marker === "fork" ? null : (
          <rect key={row.key} x={8 + row.lane * 10} y={4 + tops[index] * scale} width={W - 20 - row.lane * 10} height={Math.max(2, row.height * scale * 0.6)} rx={1.5} className={row.marker === "abandoned" || row.marker === "fold" ? "fill-[var(--ink-3)] opacity-60" : "fill-muted-foreground/40"} />
        ))}
        <rect x={2} y={4 + view.top * scale} width={W - 4} height={Math.min(H - 6, view.height * scale)} rx={3} className="fill-sidebar-primary/10 stroke-sidebar-primary" />
      </svg>
    </button>
  )
}
