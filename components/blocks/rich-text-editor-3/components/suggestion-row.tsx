import { useId } from "react"

import { Button } from "@/components/ui/button"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type {
  SuggestionResolution,
  SuggestionSummary,
} from "./rich-text-changes"
import {
  CHANGE_KIND_LABEL,
  ChangeExcerpt,
  formatChangeTime,
  PersonAvatar,
  personFor,
} from "./value-faces"
import { CheckIcon, XIcon } from "lucide-react"

// A hovered row already takes the ghost hover's gray, so each action fills
// solid in its outcome's color (the Badge recipe) on hover and focus.
const ACCEPT_HOVER =
  "hover:bg-success hover:text-white focus-visible:bg-success focus-visible:text-white focus-visible:border-success focus-visible:ring-success/30"
const REJECT_HOVER =
  "hover:bg-destructive hover:text-white focus-visible:bg-destructive focus-visible:text-white focus-visible:border-destructive focus-visible:ring-destructive/30"

interface SuggestionRowProps {
  change: SuggestionSummary
  current: boolean
  /** Viewing mode reads the list but cannot resolve it. */
  canResolve: boolean
  onSelect: (id: string) => void
  onResolve: (id: string, resolution: SuggestionResolution) => void
}

export function SuggestionRow({
  change,
  current,
  canResolve,
  onSelect,
  onResolve,
}: SuggestionRowProps) {
  const nameId = useId()
  const excerptId = useId()
  const author = personFor(change.author).name
  const kind = CHANGE_KIND_LABEL[change.kind].toLowerCase()

  // The current row takes the fill and the author's weight, so a hover fill
  // (the same value in dark) never reads as the selection.
  return (
    <li data-change-id={change.id}>
      <Item
        size="sm"
        className="hover:bg-muted/50 has-[[data-row-select][aria-current=true]]:bg-muted dark:has-[[data-row-select][aria-current=true]]:bg-muted/50 has-[[data-row-select]:focus-visible]:ring-ring/50 relative items-start has-[[data-row-select]:focus-visible]:ring-[3px]"
      >
        <ItemMedia>
          <PersonAvatar id={change.author} />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            {/* Stretched over the row, ring drawn on the row; author plus
                excerpt names it, so no two rows sound alike. */}
            <button
              type="button"
              onClick={() => onSelect(change.id)}
              aria-current={current ? "true" : undefined}
              aria-labelledby={`${nameId} ${excerptId}`}
              data-row-select=""
              className="min-w-0 truncate text-start font-normal outline-none after:absolute after:inset-0 aria-[current=true]:font-medium"
            >
              <span id={nameId}>{author}</span>
            </button>
            <span className="text-muted-foreground shrink-0 text-xs font-normal tabular-nums">
              {formatChangeTime(change.time)}
            </span>
          </ItemTitle>
          <ItemDescription className="line-clamp-3">
            <ChangeExcerpt change={change} id={excerptId} />
          </ItemDescription>
        </ItemContent>
        <ItemActions className="relative z-10 gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!canResolve}
                  className={ACCEPT_HOVER}
                  aria-label={`Accept ${kind} text from ${author}`}
                  aria-describedby={excerptId}
                  onClick={() => onResolve(change.id, "accept")}
                />
              }
            >
              <CheckIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>Accept</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={!canResolve}
                  className={REJECT_HOVER}
                  aria-label={`Reject ${kind} text from ${author}`}
                  aria-describedby={excerptId}
                  onClick={() => onResolve(change.id, "reject")}
                />
              }
            >
              <XIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>Reject</TooltipContent>
          </Tooltip>
        </ItemActions>
      </Item>
    </li>
  )
}