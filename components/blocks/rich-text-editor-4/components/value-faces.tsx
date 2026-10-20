import { cn } from "cn"

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar"

import {
  currentTime,
  PEOPLE,
  type Person,
  type PresenceStatus,
  type ToneId,
} from "./data"

export interface PersonTone {
  /** Awareness only: carets require #RRGGBB, and it is never painted. */
  hex: string
  caret: string
  label: string
  selection: string
  /** Inset border on the face, so a stacked neighbor never covers it. */
  frame: string
  dot: string
}

// One hue per person on every surface (caret, selection, frame, dot), each a
// light and dark pair; clear of the success and warning status colors.
const TONES: Record<ToneId, PersonTone> = {
  orange: {
    hex: "#c2410c",
    caret: "border-orange-700 dark:border-orange-400",
    label: "bg-orange-700 text-white dark:bg-orange-400 dark:text-orange-950",
    selection: "bg-orange-500/20 dark:bg-orange-400/25",
    frame: "after:border-orange-700 dark:after:border-orange-400",
    dot: "bg-orange-700 dark:bg-orange-400",
  },
  violet: {
    hex: "#7c3aed",
    caret: "border-violet-600 dark:border-violet-400",
    label: "bg-violet-600 text-white dark:bg-violet-400 dark:text-violet-950",
    selection: "bg-violet-500/20 dark:bg-violet-400/25",
    frame: "after:border-violet-600 dark:after:border-violet-400",
    dot: "bg-violet-600 dark:bg-violet-400",
  },
  sky: {
    hex: "#0369a1",
    caret: "border-sky-700 dark:border-sky-400",
    label: "bg-sky-700 text-white dark:bg-sky-400 dark:text-sky-950",
    selection: "bg-sky-500/20 dark:bg-sky-400/25",
    frame: "after:border-sky-700 dark:after:border-sky-400",
    dot: "bg-sky-700 dark:bg-sky-400",
  },
  pink: {
    hex: "#be185d",
    caret: "border-pink-700 dark:border-pink-400",
    label: "bg-pink-700 text-white dark:bg-pink-400 dark:text-pink-950",
    selection: "bg-pink-500/20 dark:bg-pink-400/25",
    frame: "after:border-pink-700 dark:after:border-pink-400",
    dot: "bg-pink-700 dark:bg-pink-400",
  },
}

// Someone outside PEOPLE reads neutral, never as a named teammate's hue.
const NEUTRAL_TONE: PersonTone = {
  hex: "#52525b",
  caret: "border-foreground",
  label: "bg-foreground text-background",
  selection: "bg-foreground/10",
  frame: "after:border-foreground",
  dot: "bg-foreground",
}

export function toneFor(id: unknown) {
  const person = PEOPLE.find((item) => item.id === id)
  return person ? TONES[person.tone] : NEUTRAL_TONE
}

/** An author id the demo does not know still gets a readable face. */
export function personFor(id: string): Person | Pick<Person, "name"> {
  return PEOPLE.find((person) => person.id === id) ?? { name: id || "Unknown" }
}

export function firstName(id: string) {
  const person = personFor(id)
  return "firstName" in person ? person.firstName : person.name
}

/** The Awareness user; the caret plugin requires the hex, which is never painted. */
export function awarenessUser(id: string) {
  return { id, name: firstName(id), color: toneFor(id).hex }
}

/** Presence as the local client reads it; "unsynced" is your link, not theirs. */
export type PresenceWord = PresenceStatus | "unsynced"

export const PRESENCE_LABEL: Record<PresenceWord, string> = {
  editing: "Editing",
  viewing: "Viewing",
  idle: "Idle",
  unsynced: "Not synced",
}

// Only live typing earns a dot; the word travels in the tooltip and name.
const PRESENCE_BADGE: Record<PresenceWord, string | null> = {
  editing: "bg-success",
  idle: null,
  viewing: null,
  unsynced: null,
}

export function PersonAvatar({
  id,
  presence,
  ringed = false,
  className,
}: {
  id: string
  /** Adds the status dot; the word always travels beside it. */
  presence?: PresenceWord
  /** The person's own hue, tying the face to their caret. */
  ringed?: boolean
  className?: string
}) {
  const person = personFor(id)
  const initials =
    "initials" in person ? person.initials : person.name.slice(0, 2)
  const badge = presence ? PRESENCE_BADGE[presence] : null

  return (
    <Avatar
      size="sm"
      data-presence={presence}
      className={cn(
        ringed && [
          "after:border-2 after:mix-blend-normal dark:after:mix-blend-normal",
          toneFor(id).frame,
        ],
        "data-[presence=unsynced]:opacity-50",
        className
      )}
    >
      {"avatar" in person ? <AvatarImage src={person.avatar} alt="" /> : null}
      <AvatarFallback>{initials}</AvatarFallback>
      {badge ? <AvatarBadge className={badge} /> : null}
    </Avatar>
  )
}

// Word joiners give the empty caret a line box without a break opportunity.
const WORD_JOINER = "⁠"

/** A teammate's caret for CollaborationCaret: plain DOM, painted by id. */
export function renderPeerCaret(user: Record<string, unknown>) {
  const tone = toneFor(user.id)
  const caret = document.createElement("span")
  caret.dataset.peer = String(user.id)
  caret.setAttribute("aria-hidden", "true")
  // Zero net width: 1px borders both sides against -1px margins.
  caret.className = cn(
    "pointer-events-none relative -mx-px border-x border-y-0 break-normal",
    tone.caret
  )
  const label = document.createElement("span")
  label.dataset.caretLabel = ""
  label.className = cn(
    "absolute start-0 bottom-full -translate-x-1/2 rounded-sm px-1.5 py-0.5 text-xs/none font-medium whitespace-nowrap select-none",
    tone.label
  )
  label.textContent = String(user.name ?? "")
  caret.append(WORD_JOINER, label, WORD_JOINER)
  return caret
}

export function renderPeerSelection(user: Record<string, unknown>) {
  return {
    class: toneFor(user.id).selection,
    "data-peer-selection": String(user.id),
  }
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
export function formatTime(time: string | null, now = currentTime()) {
  if (!time) return ""
  if (Date.parse(now) - Date.parse(time) < JUST_NOW_MS) return "Just now"

  const date = new Date(time)

  return time.slice(0, 10) === now.slice(0, 10)
    ? TIME_FORMAT.format(date)
    : DAY_FORMAT.format(date)
}