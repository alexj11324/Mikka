import type { Ref } from "react"
import { Badge } from "@/components/reui/badge"
import type { Editor } from "@tiptap/react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { ConnectionSwitch } from "./connection-switch"
import { SPEC_META } from "./data"
import { FollowChip } from "./follow-chip"
import { PresenceStack, type TeammatePresence } from "./presence-stack"
import { useRichTextState } from "./rich-text-state"
import { SpecActions } from "./spec-actions"
import { SpecToolbar } from "./spec-toolbar"
import { formatTime } from "./value-faces"
import { MessageSquareTextIcon } from "lucide-react"

function Dot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "bg-muted-foreground/40 size-1 shrink-0 rounded-full",
        className
      )}
    />
  )
}

export interface HeaderConnection {
  online: boolean
  pending: number
  /** Something changed since the page opened, so the stored stamp is stale. */
  edited: boolean
  onChange: (online: boolean) => void
}

export interface HeaderPresence {
  teammates: TeammatePresence[]
  following: string | null
  onFollow: (id: string) => void
  onStop: () => void
}

export interface HeaderComments {
  canComment: boolean
  onComment: () => void
  open: number
  /** Below lg the comment list lives in a Sheet this button opens. */
  showButton: boolean
  onOpenList: () => void
}

const noop = () => {}

/** The header before the room opens: the same shape, nothing to act on. */
export const HEADER_PLACEHOLDER = {
  connection: { online: true, pending: 0, edited: false, onChange: noop },
  presence: { teammates: [], following: null, onFollow: noop, onStop: noop },
  comments: {
    canComment: false,
    onComment: noop,
    open: 0,
    showButton: false,
    onOpenList: noop,
  },
} satisfies Pick<SpecHeaderProps, "connection" | "presence" | "comments">

interface SpecHeaderProps {
  ref?: Ref<HTMLElement>
  editor: Editor | null
  connection: HeaderConnection
  presence: HeaderPresence
  comments: HeaderComments
  linkOpen: boolean
  onLinkOpenChange: (open: boolean) => void
  onReplay: () => void
}

/** One sticky band: who, what and the connection above, formatting below. */
export function SpecHeader({
  ref,
  editor,
  connection,
  presence,
  comments,
  linkOpen,
  onLinkOpenChange,
  onReplay,
}: SpecHeaderProps) {
  const { online, pending, edited } = connection
  const state = useRichTextState(editor)

  return (
    <header ref={ref} className="bg-background sticky top-0 z-20 border-b">
      <div className="flex min-h-14 items-center gap-3 px-4 py-2 sm:px-6">
        <div className="flex min-w-0 flex-1 flex-col gap-px">
          <div className="flex min-w-0 items-center gap-2">
            <h1 className="truncate text-base/5 font-medium">
              {SPEC_META.title}
            </h1>
            {/* Off the phone layout but still read out: the only status words. */}
            <Badge
              variant={online ? "success-light" : "warning-light"}
              className="shrink-0 max-sm:sr-only"
            >
              {online ? "Live" : "Offline"}
            </Badge>
          </div>
          {/* Each dot travels inside its segment, so a wrap never strands one. */}
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            {/* Offline on a phone the status words take the whole line. */}
            <span className={online ? undefined : "max-sm:hidden"}>
              {SPEC_META.release}
            </span>
            <span className="inline-flex items-center gap-1.5 max-sm:hidden">
              <Dot />
              {SPEC_META.kind}
            </span>
            {online ? (
              <span className="inline-flex items-center gap-1.5 max-sm:hidden">
                <Dot />
                Edited {edited ? "just now" : formatTime(SPEC_META.editedAt)}
              </span>
            ) : (
              <span
                role="status"
                className="text-foreground inline-flex items-center gap-1.5 tabular-nums"
              >
                <Dot className="max-sm:hidden" />
                {pending === 0
                  ? "Edits save locally"
                  : `${pending} local ${pending === 1 ? "change" : "changes"}`}
              </span>
            )}
          </p>
        </div>

        <PresenceStack
          teammates={presence.teammates}
          following={presence.following}
          online={online}
          onFollow={presence.onFollow}
        />

        <div className="flex shrink-0 items-center gap-1.5">
          <ConnectionSwitch
            online={online}
            onOnlineChange={connection.onChange}
            disabled={!editor}
          />
          {comments.showButton ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Comments, ${comments.open} open`}
              onClick={comments.onOpenList}
            >
              <MessageSquareTextIcon aria-hidden="true" />
              <span className="max-sm:sr-only">Comments</span>
              <span className="text-muted-foreground tabular-nums">
                {comments.open}
              </span>
            </Button>
          ) : null}
          <SpecActions editor={editor} onReplay={onReplay} />
        </div>
      </div>

      <div className="flex items-center gap-2 border-t px-4 py-2 sm:px-6">
        <SpecToolbar
          editor={editor}
          state={state}
          linkOpen={linkOpen}
          onLinkOpenChange={onLinkOpenChange}
          canComment={comments.canComment}
          onComment={comments.onComment}
        />
        {presence.following ? (
          <FollowChip peer={presence.following} onStop={presence.onStop} />
        ) : null}
      </div>
    </header>
  )
}