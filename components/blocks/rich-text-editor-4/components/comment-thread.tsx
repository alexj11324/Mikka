import { useId, useState, type KeyboardEvent, type RefObject } from "react"

import { Button } from "@/components/ui/button"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemFooter,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { CURRENT_USER } from "./data"
import type { ThreadRecord } from "./rich-text-comments"
import { firstName, formatTime, PersonAvatar, personFor } from "./value-faces"
import { CheckIcon } from "lucide-react"

// A hovered row already takes the ghost hover's gray, so Resolve fills solid
// in its outcome's color on hover and focus.
const RESOLVE_HOVER =
  "hover:bg-success hover:text-white focus-visible:bg-success focus-visible:text-white focus-visible:border-success focus-visible:ring-success/30"

// The current row takes the input tint, lighter than muted, so its reply
// field and Send stay legible; only the other rows take the hover fill.
const ROW =
  "not-has-[[data-thread-select][aria-current=true]]:hover:bg-muted/50 has-[[data-thread-select][aria-current=true]]:bg-input/30 has-[[data-thread-select]:focus-visible]:ring-ring/50 relative items-start has-[[data-thread-select]:focus-visible]:ring-[3px]"

function Excerpt({ id, text }: { id: string; text: string | null }) {
  return (
    <ItemDescription id={id} className="line-clamp-1">
      {text ? `“${text}”` : "Anchor text removed"}
    </ItemDescription>
  )
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`
}

function isSubmitKey(event: KeyboardEvent) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey)
}

interface CommentThreadProps {
  thread: ThreadRecord
  excerpt: string | null
  current: boolean
  /** First names of teammates typing a reply right now. */
  replying: string[]
  onSelect: (id: string) => void
  onResolve: (id: string) => void
  onReply: (id: string, body: string) => void
}

export function CommentThread({
  thread,
  excerpt,
  current,
  replying,
  onSelect,
  onResolve,
  onReply,
}: CommentThreadProps) {
  const nameId = useId()
  const excerptId = useId()
  const [draft, setDraft] = useState("")
  const [first, ...replies] = thread.messages
  const author = personFor(thread.author).name
  const own = thread.author === CURRENT_USER

  function submit() {
    const body = draft.trim()
    if (!body) return
    onReply(thread.id, body)
    setDraft("")
  }

  return (
    <li data-thread-id={thread.id}>
      <Item size="sm" className={ROW}>
        <ItemMedia>
          <PersonAvatar id={thread.author} ringed />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle className="w-full">
            {/* Stretched over the row, ring drawn on the row; author plus
                excerpt names it, so no two rows sound alike. */}
            <button
              type="button"
              onClick={() => onSelect(thread.id)}
              aria-current={current ? "true" : undefined}
              aria-labelledby={`${nameId} ${excerptId}`}
              data-thread-select=""
              className="min-w-0 truncate text-start font-normal outline-none after:absolute after:inset-0 aria-[current=true]:font-medium"
            >
              <span id={nameId}>{author}</span>
            </button>
            <span className="text-muted-foreground shrink-0 text-xs font-normal tabular-nums">
              {formatTime(thread.createdAt)}
            </span>
          </ItemTitle>
          <Excerpt id={excerptId} text={excerpt} />
          {first ? (
            <p className={current ? "text-sm" : "line-clamp-2 text-sm"}>
              {first.body}
            </p>
          ) : null}
          {current
            ? replies.map((message) => (
                <div key={message.id} className="flex flex-col gap-0.5 pt-1.5">
                  <p className="flex items-baseline gap-2 text-sm font-medium">
                    {personFor(message.author).name}
                    <span className="text-muted-foreground text-xs font-normal tabular-nums">
                      {formatTime(message.at)}
                    </span>
                  </p>
                  <p className="text-sm">{message.body}</p>
                </div>
              ))
            : null}
          {!current && replies.length > 0 ? (
            <p className="text-muted-foreground text-xs">
              {plural(replies.length, "reply", "replies")}
            </p>
          ) : null}
          {/* Always mounted, so a screen reader hears the text arrive. */}
          <p
            aria-live="polite"
            className="text-muted-foreground text-xs empty:hidden"
          >
            {replying.length > 0
              ? `${replying.join(" and ")} ${replying.length === 1 ? "is" : "are"} replying`
              : null}
          </p>
        </ItemContent>
        <ItemActions className="relative z-10 gap-0.5">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className={RESOLVE_HOVER}
                  aria-label={`Resolve thread from ${author}`}
                  aria-describedby={excerptId}
                  onClick={() => onResolve(thread.id)}
                />
              }
            >
              <CheckIcon aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>Resolve</TooltipContent>
          </Tooltip>
        </ItemActions>
        {/* A full-width row, so the reply gets the card's width, not the text column's. */}
        {current ? (
          <ItemFooter className="relative z-10">
            <form
              className="w-full"
              onSubmit={(event) => {
                event.preventDefault()
                submit()
              }}
            >
              <InputGroup>
                {/* One line at rest, growing with the reply up to a scroll cap. */}
                <InputGroupTextarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    // Enter sends, Shift+Enter breaks the line.
                    const send =
                      isSubmitKey(event) ||
                      (event.key === "Enter" && !event.shiftKey)
                    if (!send || event.nativeEvent.isComposing) return
                    event.preventDefault()
                    submit()
                  }}
                  rows={1}
                  autoComplete="off"
                  placeholder={
                    own ? "Add a reply" : `Reply to ${firstName(thread.author)}`
                  }
                  aria-label={own ? "Add a reply" : `Reply to ${author}`}
                  className="max-h-32 min-h-0"
                />
                {/* Inline end keeps Send beside the text, pinned to its last line. */}
                <InputGroupAddon align="inline-end" className="self-end">
                  <InputGroupButton
                    type="submit"
                    variant="default"
                    size="xs"
                    disabled={!draft.trim()}
                    focusableWhenDisabled
                    className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                  >
                    Send
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </form>
          </ItemFooter>
        ) : null}
      </Item>
    </li>
  )
}

interface DraftThreadProps {
  excerpt: string
  fieldRef: RefObject<HTMLTextAreaElement | null>
  onSubmit: (body: string) => void
  onCancel: () => void
}

/** A new thread at its place in the list, before it exists anywhere else. */
export function DraftThread({
  excerpt,
  fieldRef,
  onSubmit,
  onCancel,
}: DraftThreadProps) {
  const excerptId = useId()
  const [body, setBody] = useState("")

  function submit() {
    if (body.trim()) onSubmit(body.trim())
  }

  return (
    <li data-thread-id="draft">
      <Item size="sm" className="bg-input/30 items-start">
        <ItemMedia>
          <PersonAvatar id={CURRENT_USER} ringed />
        </ItemMedia>
        <ItemContent className="min-w-0">
          <ItemTitle>{personFor(CURRENT_USER).name}</ItemTitle>
          <Excerpt id={excerptId} text={excerpt} />
          <form
            className="pt-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <InputGroup>
              <InputGroupTextarea
                ref={fieldRef}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                onKeyDown={(event) => {
                  if (isSubmitKey(event)) {
                    event.preventDefault()
                    submit()
                  } else if (event.key === "Escape") {
                    event.preventDefault()
                    onCancel()
                  }
                }}
                placeholder="Add a comment"
                aria-label="New comment"
                aria-describedby={excerptId}
                rows={2}
                autoFocus
              />
              <InputGroupAddon align="block-end" className="justify-end gap-1">
                <InputGroupButton size="xs" onClick={onCancel}>
                  Cancel
                </InputGroupButton>
                <InputGroupButton
                  type="submit"
                  variant="default"
                  size="xs"
                  disabled={!body.trim()}
                  focusableWhenDisabled
                  className="aria-disabled:pointer-events-none aria-disabled:opacity-50"
                >
                  Comment
                </InputGroupButton>
              </InputGroupAddon>
            </InputGroup>
          </form>
        </ItemContent>
      </Item>
    </li>
  )
}