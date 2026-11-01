"use client"

import * as React from "react"
import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

import { SegmentIndicator } from "@/components/ui/segment-indicator"

// The list's variant and id, so the selected trigger draws the one indicator that glides between triggers.
const TabsListContext = React.createContext<{ variant: "default" | "line"; id: string } | null>(null)

function Tabs({
  className,
  orientation = "horizontal",
  ...props
}: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      data-orientation={orientation}
      className={cn(
        "group/tabs flex gap-2 data-horizontal:flex-col",
        className
      )}
      {...props}
    />
  )
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      // default is the segmented control's track (as ToggleGroup variant="segment"): `--control`, 8px, items inset by 2px.
      variant: {
        default: "rounded-md bg-control p-0.5",
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & VariantProps<typeof tabsListVariants>) {
  const id = React.useId()
  const list = React.useMemo(() => ({ variant: variant ?? "default", id }), [variant, id])
  return (
    <TabsListContext.Provider value={list}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(tabsListVariants({ variant }), className)}
        {...props}
      />
    </TabsListContext.Provider>
  )
}

function TabsTrigger({ className, render, indicator = true, ...props }: TabsPrimitive.Tab.Props & {
  /** false: no gliding indicator; the call site styles the selected tab itself. */
  indicator?: boolean
}) {
  const context = React.useContext(TabsListContext)
  const list = indicator ? context : null
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      // R-37: the selected mark is one element per list that glides to the new tab on a spring,
      // a raised pill on the default track and an underline on the line list. It covers the trigger's
      // transparent 1px border, so it lines up with the trigger's edge.
      render={render ?? (list ? (tabProps, state) => <button {...tabProps}>
        {state.active && <SegmentIndicator layoutId={`tabs-${list.id}`} variant={list.variant === "line" ? "line" : "pill"} className={list.variant === "line" ? "-inset-x-px" : "-inset-px"} />}
        {tabProps.children}
      </button> : undefined)}
      className={cn(
        "relative isolate inline-flex h-full flex-1 items-center justify-center gap-1.5 rounded-sm border border-transparent px-2.5 py-0.5 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-active:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "group-data-[variant=line]/tabs-list:px-1.5",
        className
      )}
      {...props}
    />
  )
}

function TabsContent({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants }
