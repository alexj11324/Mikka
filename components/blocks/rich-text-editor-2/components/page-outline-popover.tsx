import { useState } from "react"
import type { Editor } from "@tiptap/react"

import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover"
import {
  RichTextOutlineList,
  type RichTextOutlineEntry,
} from "./rich-text-outline"
import { TableOfContentsIcon } from "lucide-react"

interface PageOutlinePopoverProps {
  editor: Editor | null
  outline: RichTextOutlineEntry[]
  activeHeading: number
  onHeadingSelect: (index: number) => void
}

/** The outline rail's list where the rail cannot open: narrow screens and touch. */
export function PageOutlinePopover({
  editor,
  outline,
  activeHeading,
  onHeadingSelect,
}: PageOutlinePopoverProps) {
  const [open, setOpen] = useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Outline"
            disabled={outline.length === 0}
            className="md:pointer-fine:hidden"
          />
        }
      >
        <TableOfContentsIcon aria-hidden="true" />
      </PopoverTrigger>
      {/* The caret moves to the chosen heading, so focus returns to the page. */}
      <PopoverContent
        align="end"
        className="w-56"
        finalFocus={() => editor?.view.dom ?? true}
      >
        <PopoverHeader>
          <PopoverTitle>Outline</PopoverTitle>
        </PopoverHeader>
        <nav aria-label="Outline">
          <RichTextOutlineList
            outline={outline}
            activeIndex={activeHeading}
            onSelect={(index) => {
              setOpen(false)
              onHeadingSelect(index)
            }}
            className="no-scrollbar supports-[animation-timeline:scroll()]:scroll-fade-y max-h-72 overflow-y-auto p-0.5"
          />
        </nav>
      </PopoverContent>
    </Popover>
  )
}