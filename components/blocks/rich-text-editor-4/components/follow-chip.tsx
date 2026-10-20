import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  ButtonGroup,
  ButtonGroupText,
} from "@/components/ui/button-group"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import { ShortcutKeys } from "./rich-text-toolbar"
import { firstName, toneFor } from "./value-faces"

interface FollowChipProps {
  /** The followed teammate's Awareness id. */
  peer: string
  onStop: () => void
}

/** What is on, and the way out: Stop, Escape, a scroll or your own typing. */
export function FollowChip({ peer, onStop }: FollowChipProps) {
  const name = firstName(peer)

  return (
    <ButtonGroup aria-label={`Following ${name}`} className="shrink-0">
      <ButtonGroupText className="whitespace-nowrap">
        <span
          aria-hidden="true"
          className={cn("size-2 shrink-0 rounded-full", toneFor(peer).dot)}
        />
        {/* On a phone the name stays; only the verb steps aside. */}
        <span>
          <span className="max-sm:sr-only">Following </span>
          {name}
        </span>
      </ButtonGroupText>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              aria-keyshortcuts="Escape"
              onClick={onStop}
            />
          }
        >
          Stop
        </TooltipTrigger>
        <TooltipContent>
          Stop Following
          <ShortcutKeys keys={["Esc"]} />
        </TooltipContent>
      </Tooltip>
    </ButtonGroup>
  )
}