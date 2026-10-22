"use client"

import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card"
import { cn } from "cn"

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"

/** A source cited inline in text: a small chip that previews the source on hover. */
function InlineCitation({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <HoverCard data-slot="inline-citation" {...props} />
}

function InlineCitationTrigger({
  className,
  delay = 200,
  closeDelay = 100,
  render = <button type="button" />,
  ...props
}: PreviewCardPrimitive.Trigger.Props) {
  return (
    <HoverCardTrigger
      data-slot="inline-citation-trigger"
      render={render}
      delay={delay}
      closeDelay={closeDelay}
      className={cn(
        "mx-0.5 inline-flex h-5 max-w-56 cursor-pointer items-center gap-1 rounded-full border border-border bg-muted/50 px-1.5 align-text-bottom text-xs font-medium text-muted-foreground no-underline outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted data-popup-open:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3",
        className
      )}
      {...props}
    />
  )
}

function InlineCitationLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="inline-citation-label" className={cn("min-w-0 truncate", className)} {...props} />
}

function InlineCitationContent({
  className,
  side = "top",
  align = "start",
  ...props
}: React.ComponentProps<typeof HoverCardContent>) {
  return (
    <HoverCardContent
      data-slot="inline-citation-content"
      side={side}
      align={align}
      className={cn("flex w-72 flex-col gap-2 p-3", className)}
      {...props}
    />
  )
}

function InlineCitationSource({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-citation-source"
      className={cn("flex items-center gap-1.5 text-xs text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5", className)}
      {...props}
    />
  )
}

function InlineCitationTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="inline-citation-title" className={cn("line-clamp-2 text-sm font-medium leading-snug", className)} {...props} />
}

function InlineCitationMeta({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-citation-meta"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5 [&>*]:inline-flex [&>*]:items-center [&>*]:gap-1", className)}
      {...props}
    />
  )
}

export {
  InlineCitation,
  InlineCitationTrigger,
  InlineCitationLabel,
  InlineCitationContent,
  InlineCitationSource,
  InlineCitationTitle,
  InlineCitationMeta,
}
