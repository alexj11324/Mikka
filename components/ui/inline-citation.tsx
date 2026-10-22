"use client"

import { useState } from "react"
import { PreviewCard as PreviewCardPrimitive } from "@base-ui/react/preview-card"
import { ArrowUpRight, Globe } from "lucide-react"
import { cn } from "cn"

import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { sourceChipClassName } from "@/components/ui/streaming-text"

/** A source cited inline in text: a small chip that previews the source on hover. */
function InlineCitation({ ...props }: PreviewCardPrimitive.Root.Props) {
  return <HoverCard data-slot="inline-citation" {...props} />
}

/** The chip, styled like the streaming-text SourceChip. A button by default; pass `render={<a href=… />}` for a web page. */
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
      className={cn(sourceChipClassName, className)}
      {...props}
    />
  )
}

function InlineCitationLabel({ className, ...props }: React.ComponentProps<"span">) {
  return <span data-slot="inline-citation-label" className={cn("min-w-0 truncate", className)} {...props} />
}

/** A site's icon, or a globe when it has none or it fails to load. */
function InlineCitationFavicon({ src, className }: { src?: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  if (!src || failed === src) return <Globe data-slot="inline-citation-favicon" className={className} />
  // eslint-disable-next-line @next/next/no-img-element -- third-party favicons, any host
  return <img data-slot="inline-citation-favicon" src={src} alt="" referrerPolicy="no-referrer" className={cn("object-contain", className)} onError={() => setFailed(src)} />
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
      className={cn("flex w-80 flex-col overflow-hidden p-0", className)}
      {...props}
    />
  )
}

/** A web page's preview image, edge to edge at the top of the card. Hidden if it fails to load. */
function InlineCitationImage({ src, className }: { src: string; className?: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  // eslint-disable-next-line @next/next/no-img-element -- third-party preview images, any host
  return <img data-slot="inline-citation-image" src={src} alt="" referrerPolicy="no-referrer" className={cn("aspect-[1.91/1] w-full bg-muted object-cover", className)} onError={() => setFailed(true)} />
}

function InlineCitationBody({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="inline-citation-body" className={cn("flex flex-col gap-1.5 p-3", className)} {...props} />
}

function InlineCitationSource({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-citation-source"
      className={cn("flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground [&_img]:size-3.5 [&_img]:shrink-0 [&_img]:rounded-xs [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5", className)}
      {...props}
    />
  )
}

function InlineCitationTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="inline-citation-title" className={cn("line-clamp-2 text-sm font-medium leading-snug", className)} {...props} />
}

function InlineCitationDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="inline-citation-description" className={cn("line-clamp-3 text-xs leading-normal text-muted-foreground", className)} {...props} />
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

/** The bottom row of a web page's card: its icon and address, and an arrow that says it opens elsewhere. */
function InlineCitationFooter({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-citation-footer"
      className={cn("flex min-w-0 items-center gap-1.5 px-3 pb-3 text-xs text-muted-foreground [&_img]:size-3.5 [&_img]:shrink-0 [&_img]:rounded-xs [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-3.5", className)}
      {...props}
    >
      {children}
      <ArrowUpRight className="ml-auto" />
    </div>
  )
}

export {
  InlineCitation,
  InlineCitationTrigger,
  InlineCitationLabel,
  InlineCitationFavicon,
  InlineCitationContent,
  InlineCitationImage,
  InlineCitationBody,
  InlineCitationSource,
  InlineCitationTitle,
  InlineCitationDescription,
  InlineCitationMeta,
  InlineCitationFooter,
}
