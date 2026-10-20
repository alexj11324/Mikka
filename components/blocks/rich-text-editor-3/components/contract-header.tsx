import type { Ref } from "react"
import { Badge } from "@/components/reui/badge"
import type { Editor } from "@tiptap/react"

import { AvatarGroup } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { ChangeNavigator } from "./change-navigator"
import { ContractActions } from "./contract-actions"
import { ContractToolbar } from "./contract-toolbar"
import { CONTRACT_META, PEOPLE } from "./data"
import { ModeSelect, type EditorMode } from "./mode-select"
import { useRichTextChangesPosition } from "./rich-text-changes"
import { useRichTextState } from "./rich-text-state"
import { formatChangeTime, PersonAvatar } from "./value-faces"
import { ListChecksIcon } from "lucide-react"

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

interface ContractHeaderProps {
  ref?: Ref<HTMLElement>
  editor: Editor | null
  mode: EditorMode
  onModeChange: (mode: EditorMode) => void
  /** The text changed in this session, so the stored stamp is stale. */
  edited: boolean
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
  onReveal: (id: string) => void
  /** Below lg the review list lives in a Sheet this button opens. */
  showSuggestionsButton: boolean
  onOpenSuggestions: () => void
}

/** One sticky band: who and what above, formatting and the change stepper below. */
export function ContractHeader({
  ref,
  editor,
  mode,
  onModeChange,
  edited,
  linkOpen,
  onLinkOpenChange,
  onReveal,
  showSuggestionsButton,
  onOpenSuggestions,
}: ContractHeaderProps) {
  const state = useRichTextState(editor)
  // Count and caret index only, so a keystroke inside a suggestion leaves the
  // header and its toolbar alone.
  const position = useRichTextChangesPosition(editor)
  const open = position.total

  return (
    <header ref={ref} className="bg-background sticky top-0 z-20 border-b">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base/5 font-medium">
              {CONTRACT_META.title}
            </h1>
            {/* Off the phone layout but still read out: the only status words. */}
            <Badge
              variant={open > 0 ? "warning-light" : "success-light"}
              className="shrink-0 max-sm:sr-only"
            >
              {open > 0 ? "In Review" : "All Resolved"}
            </Badge>
          </div>
          {/* Each dot travels inside its segment, so a wrap never strands one. */}
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            <span>{CONTRACT_META.counterparty}</span>
            <span className="inline-flex items-center gap-1.5">
              <Dot />
              Round {CONTRACT_META.round}
            </span>
            <span className="inline-flex items-center gap-1.5 max-sm:hidden">
              <Dot />
              Edited{" "}
              {edited ? "just now" : formatChangeTime(CONTRACT_META.editedAt)}
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
              <PersonAvatar key={person.id} id={person.id} />
            ))}
          </TooltipTrigger>
          <TooltipContent>{SHARED_WITH}</TooltipContent>
        </Tooltip>

        <div className="flex shrink-0 items-center gap-1.5">
          <ModeSelect mode={mode} onModeChange={onModeChange} />
          {showSuggestionsButton ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Suggestions, ${open} open`}
              onClick={onOpenSuggestions}
            >
              <ListChecksIcon aria-hidden="true" />
              <span className="max-sm:sr-only">Suggestions</span>
              <span className="text-muted-foreground tabular-nums">{open}</span>
            </Button>
          ) : null}
          <ContractActions editor={editor} />
        </div>
      </div>

      <div className="flex items-center gap-2 border-t px-4 py-2 sm:px-6">
        <ContractToolbar
          editor={editor}
          state={state}
          linkOpen={linkOpen}
          onLinkOpenChange={onLinkOpenChange}
        />
        <ChangeNavigator
          editor={editor}
          position={position}
          onReveal={onReveal}
        />
      </div>
    </header>
  )
}