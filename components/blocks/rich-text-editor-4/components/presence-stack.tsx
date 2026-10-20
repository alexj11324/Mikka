import { cn } from "cn"

import { AvatarGroup } from "@/components/ui/avatar"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

import {
  firstName,
  PersonAvatar,
  personFor,
  PRESENCE_LABEL,
  type PresenceWord,
} from "./value-faces"

export interface TeammatePresence {
  /** The Awareness user id. */
  id: string
  presence: PresenceWord
  /** Only a teammate with a caret on the page can be followed. */
  followable: boolean
}

function Dot() {
  return (
    <span
      aria-hidden="true"
      className="bg-background/40 size-1 shrink-0 rounded-full"
    />
  )
}

interface PresenceStackProps {
  teammates: TeammatePresence[]
  following: string | null
  /** Offline, nobody's status is known, so the count steps aside. */
  online: boolean
  onFollow: (id: string) => void
  className?: string
}

/** Who is here, in words as well as dots; a face with a caret can be followed. */
export function PresenceStack({
  teammates,
  following,
  online,
  onFollow,
  className,
}: PresenceStackProps) {
  const editing = teammates.filter((item) => item.presence === "editing").length
  const summary =
    editing > 0 ? `${editing} editing` : `${teammates.length} here`

  return (
    <div className={cn("flex items-center gap-2", className)}>
      {online ? (
        <span className="text-muted-foreground text-xs tabular-nums max-md:hidden">
          {summary}
        </span>
      ) : null}
      <AvatarGroup
        role="group"
        aria-label={
          online
            ? `${teammates.length} teammates here, ${editing} editing`
            : "Presence paused while you are offline"
        }
      >
        {teammates.map((teammate) => {
          const name = personFor(teammate.id).name
          const status = PRESENCE_LABEL[teammate.presence]
          const followed = following === teammate.id
          const action = followed ? "Stop following" : "Follow"

          return (
            <Tooltip key={teammate.id}>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label={
                      teammate.followable
                        ? `${action} ${name}, ${status}`
                        : `${name}, ${status}`
                    }
                    aria-pressed={teammate.followable ? followed : undefined}
                    aria-disabled={teammate.followable ? undefined : true}
                    onClick={() => {
                      if (teammate.followable) onFollow(teammate.id)
                    }}
                    className="focus-visible:ring-ring/50 relative rounded-full outline-none hover:z-10 focus-visible:z-10 focus-visible:ring-[3px] aria-disabled:cursor-default"
                  />
                }
              >
                {/* The group's page-color cutout, set here because the face
                    sits inside its follow button. */}
                <PersonAvatar
                  id={teammate.id}
                  presence={teammate.presence}
                  ringed
                  className="ring-background ring-2"
                />
              </TooltipTrigger>
              <TooltipContent className="flex items-center gap-1.5">
                {teammate.followable
                  ? `${action} ${firstName(teammate.id)}`
                  : name}
                <Dot />
                {status}
              </TooltipContent>
            </Tooltip>
          )
        })}
      </AvatarGroup>
    </div>
  )
}