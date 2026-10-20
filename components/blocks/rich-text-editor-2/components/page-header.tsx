import type { Ref } from "react"
import { Badge } from "@/components/reui/badge"
import type { Editor } from "@tiptap/react"

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarImage,
} from "@/components/ui/avatar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { PAGE_META, PEOPLE } from "./data"
import { PageActions, type PageActionsProps } from "./page-actions"
import { PageOutlinePopover } from "./page-outline-popover"
import { RichTextHistory } from "./rich-text-controls"
import type { RichTextOutlineEntry } from "./rich-text-outline"
import { useRichTextState } from "./rich-text-state"
import { RichTextToolbarSeparator } from "./rich-text-toolbar"

export type SaveState = "saved" | "saving"

// Local midnight, so the stored day never shifts with the viewer's time zone.
const EDITED_ON = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
}).format(new Date(`${PAGE_META.editedAt}T00:00:00`))

const SHARED_WITH = `Shared with ${new Intl.ListFormat("en-US").format(
  PEOPLE.map((person) => person.name)
)}`

function Dot() {
  return (
    <span
      aria-hidden="true"
      className="bg-muted-foreground/40 size-1 shrink-0 rounded-full"
    />
  )
}

interface PageHeaderProps extends Omit<PageActionsProps, "editor"> {
  ref?: Ref<HTMLElement>
  editor: Editor | null
  /** The text changed in this session, so the stored stamp is stale. */
  edited: boolean
  saveState: SaveState
  outline: RichTextOutlineEntry[]
  activeHeading: number
  onHeadingSelect: (index: number) => void
}

/** The page's sticky band: what it is and who has it, history and actions. */
export function PageHeader({
  ref,
  editor,
  edited,
  saveState,
  outline,
  activeHeading,
  onHeadingSelect,
  ...actions
}: PageHeaderProps) {
  const state = useRichTextState(editor)

  return (
    <header
      ref={ref}
      className="bg-background sticky top-0 z-20 flex min-h-14 items-center gap-3 border-b px-4 py-2 sm:px-6"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-px">
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-base/5 font-medium">
            {PAGE_META.title}
          </h1>
          {actions.editable ? null : (
            <Badge variant="outline" className="shrink-0 font-normal">
              Locked
            </Badge>
          )}
        </div>
        {/* Each dot travels inside its segment, so a wrap never strands one. */}
        <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span>{PAGE_META.space}</span>
          <span className="inline-flex items-center gap-1.5 max-sm:hidden">
            <Dot />
            Edited {edited ? "just now" : EDITED_ON}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Dot />
            <span aria-live="polite">
              {saveState === "saving" ? "Saving…" : "Saved"}
            </span>
          </span>
        </p>
      </div>

      {/* One reveal for the stack; it takes focus, so keys and taps reach it too. */}
      <Tooltip>
        <TooltipTrigger
          render={
            <AvatarGroup
              role="group"
              tabIndex={0}
              aria-label={SHARED_WITH}
              className="max-md:hidden"
            />
          }
        >
          {PEOPLE.map((person) => (
            <Avatar key={person.id} size="sm">
              <AvatarImage src={person.avatar} alt={person.name} />
              <AvatarFallback>{person.initials}</AvatarFallback>
            </Avatar>
          ))}
        </TooltipTrigger>
        <TooltipContent>{SHARED_WITH}</TooltipContent>
      </Tooltip>

      <div className="flex shrink-0 items-center gap-1">
        <RichTextHistory editor={editor} state={state} />
        <RichTextToolbarSeparator />
        <PageOutlinePopover
          editor={editor}
          outline={outline}
          activeHeading={activeHeading}
          onHeadingSelect={onHeadingSelect}
        />
        <PageActions editor={editor} {...actions} />
      </div>
    </header>
  )
}