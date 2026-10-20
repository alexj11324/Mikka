import { cn } from "cn"

import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"

import { currentTime, PEOPLE, type Person } from "./data"
import {
  SUGGESTION_TINTS,
  type SuggestionKind,
  type SuggestionSummary,
} from "./rich-text-changes"

/** An author id the demo does not know still gets a readable face. */
export function personFor(id: string): Person | Pick<Person, "name"> {
  return PEOPLE.find((person) => person.id === id) ?? { name: id || "Unknown" }
}

export function PersonAvatar({
  id,
  className,
}: {
  id: string
  className?: string
}) {
  const person = personFor(id)
  const initials =
    "initials" in person ? person.initials : person.name.slice(0, 2)

  return (
    <Avatar size="sm" className={className}>
      {"avatar" in person ? (
        <AvatarImage src={person.avatar} alt={person.name} />
      ) : null}
      <AvatarFallback>{initials}</AvatarFallback>
    </Avatar>
  )
}

export const CHANGE_KIND_LABEL: Record<SuggestionKind, string> = {
  insert: "Added",
  delete: "Deleted",
  replace: "Replaced",
}

// An edit often starts on the space or comma before a word; the excerpt shows
// the words (or the bare mark if that is all), the document is untouched.
function excerptText(text: string) {
  return text.trim().replace(/^[,;:.]\s*/, "") || text
}

/** Kind word first, so the change never depends on colour alone. */
export function ChangeExcerpt({
  change,
  id,
  className,
}: {
  change: SuggestionSummary
  id?: string
  className?: string
}) {
  const deleted = excerptText(change.deleted)
  const inserted = excerptText(change.inserted)

  // The document's tints, so a row reads like the text it points at.
  return (
    <span
      id={id}
      className={cn(SUGGESTION_TINTS, "[&_ins]:underline-offset-2", className)}
    >
      <span className="text-foreground font-medium">
        {CHANGE_KIND_LABEL[change.kind]}
      </span>{" "}
      {deleted ? <del>{deleted}</del> : null}
      {deleted && inserted ? " " : null}
      {inserted ? <ins>{inserted}</ins> : null}
    </span>
  )
}

const DAY_FORMAT = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC",
})

const TIME_FORMAT = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "UTC",
})

const JUST_NOW_MS = 60_000

// Relative to the block's one clock. Demo stamps are UTC, so every viewer reads
// the same times; drop timeZone for a real clock in the viewer's zone.
export function formatChangeTime(time: string | null, now = currentTime()) {
  if (!time) return ""
  if (Date.parse(now) - Date.parse(time) < JUST_NOW_MS) return "Just now"

  const date = new Date(time)

  return time.slice(0, 10) === now.slice(0, 10)
    ? TIME_FORMAT.format(date)
    : DAY_FORMAT.format(date)
}