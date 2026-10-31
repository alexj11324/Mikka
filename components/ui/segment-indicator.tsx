"use client"

import { motion, useReducedMotion } from "motion/react"
import { cn } from "cn"

import { SPRING_LAYOUT } from "@/lib/ease"

/**
 * The selected mark of a segmented control or tab list: one element per group that glides
 * to the new item on `SPRING_LAYOUT` (R-37). Render it inside the selected item only, with
 * the group's `layoutId`. With reduced motion it lands at once: the root `MotionConfig
 * reducedMotion="user"` does not stop shared-layout (`layoutId`) moves, so this checks the setting itself.
 */
function SegmentIndicator({
  layoutId,
  variant = "pill",
  className,
}: {
  layoutId: string
  variant?: "pill" | "line"
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.span
      layoutId={layoutId}
      transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
      aria-hidden="true"
      data-slot="segment-indicator"
      // The radius is a style so Motion corrects it while the pill stretches between items of different widths.
      style={variant === "pill" ? { borderRadius: 6 } : undefined}
      className={cn(
        "pointer-events-none absolute -z-10",
        variant === "pill"
          ? "inset-0 bg-background shadow-xs dark:bg-control-hover"
          : "inset-x-0 -bottom-[5px] h-0.5 bg-foreground",
        className
      )}
    />
  )
}

export { SegmentIndicator }
