import type { JSONContent } from "@tiptap/react"

import type { PeerTrack } from "./peer-script"
import type { ThreadSeed } from "./rich-text-comments"

export type PersonId = "arjun" | "maya" | "lena" | "daniel"
export type PeerId = Exclude<PersonId, "arjun">
export type PresenceStatus = "editing" | "viewing" | "idle"
/** Each person's hue on caret, selection, avatar ring and follow chip. */
export type ToneId = "orange" | "violet" | "sky" | "pink"

export interface Person {
  id: PersonId
  name: string
  firstName: string
  role: string
  initials: string
  avatar: string
  tone: ToneId
}

export const PEOPLE: Person[] = [
  {
    id: "arjun",
    name: "Arjun Mehta",
    firstName: "Arjun",
    role: "Product designer",
    initials: "AM",
    avatar:
      "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&dpr=2&q=80",
    tone: "orange",
  },
  {
    id: "maya",
    name: "Maya Chen",
    firstName: "Maya",
    role: "Product marketing lead",
    initials: "MC",
    avatar:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
    tone: "violet",
  },
  {
    id: "lena",
    name: "Lena Hoffmann",
    firstName: "Lena",
    role: "Engineering manager, search",
    initials: "LH",
    avatar:
      "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=96&h=96&dpr=2&q=80",
    tone: "sky",
  },
  {
    id: "daniel",
    name: "Daniel Okafor",
    firstName: "Daniel",
    role: "Support operations manager",
    initials: "DO",
    avatar:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&dpr=2&q=80",
    tone: "pink",
  },
]

/** The signed-in writer: local edits, comments and replies carry this id. */
export const CURRENT_USER: PersonId = "arjun"

/** Everyone else in the room, in the presence stack's order. */
export const TEAMMATES: PeerId[] = ["maya", "lena", "daniel"]

const DEMO_NOW = "2026-09-26T15:00:00.000Z"

/** The one clock: it stamps new comments and anchors "Just now".
 * customize: return the real time as an ISO string instead of the demo date. */
export function currentTime() {
  return DEMO_NOW
}

export const SPEC_META = {
  title: "Shared Drafts",
  release: "Loomwell 4.3",
  kind: "Product spec",
  editedAt: "2026-09-26T14:20:00.000Z",
}

function text(value: string): JSONContent {
  return { type: "text", text: value }
}

function commented(value: string, id: string): JSONContent {
  return {
    type: "text",
    text: value,
    marks: [{ type: "comment", attrs: { id } }],
  }
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: "paragraph", content }
}

function heading(value: string): JSONContent {
  return { type: "heading", attrs: { level: 2 }, content: [text(value)] }
}

function bullets(...items: JSONContent[][]): JSONContent {
  return {
    type: "bulletList",
    content: items.map((content) => ({
      type: "listItem",
      content: [paragraph(...content)],
    })),
  }
}

function numbered(...items: JSONContent[][]): JSONContent {
  return { ...bullets(...items), type: "orderedList" }
}

function task(checked: boolean, value: string): JSONContent {
  return {
    type: "taskItem",
    attrs: { checked },
    content: [paragraph(text(value))],
  }
}

// Ends on a paragraph: StarterKit appends one otherwise, as an edit every
// client would make on its own.
export const SPEC: JSONContent = {
  type: "doc",
  content: [
    paragraph(
      text(
        "Loomwell 4.3 lets two support agents write one customer reply together before it goes out. This spec covers the first release, planned for general availability on November 18."
      )
    ),
    heading("Problem"),
    paragraph(
      text(
        "Hard tickets pull in a second agent on 22% of escalations. Today the helper pastes a draft into an internal note, waits for a thumbs up, and the owner copies the final text back into the reply. Across 1,840 escalations in August, that loop added "
      ),
      commented("a median of 14 minutes", "t-handoff"),
      text(" to first response.")
    ),
    heading("Goals"),
    bullets(
      [
        text(
          "Two agents edit the same reply draft at once, with named cursors, and see each other’s changes as they type."
        ),
      ],
      [
        text(
          "Cut the median handoff on escalations from 14 minutes to under 5."
        ),
      ],
      [text("Every draft keeps one owner, and only the owner sends it.")],
      [text("Nothing typed is lost when an agent drops offline.")]
    ),
    heading("Non-Goals"),
    bullets(
      [text("Co-editing internal notes, macros or help center articles.")],
      [text("Suggesting mode or tracked changes inside a reply.")]
    ),
    heading("How It Works"),
    paragraph(
      text(
        "Any agent on a ticket can invite a teammate from the reply box. The teammate joins the draft in place, and a presence row above the composer shows everyone in it. "
      ),
      commented("Only the owner can press Send", "t-owner"),
      text(
        "; a teammate can ask for ownership and the owner approves it in one click."
      )
    ),
    paragraph(
      text(
        "Drafts sync through the existing realtime gateway. If an agent drops offline, edits queue locally and merge on reconnect, so no one loses text."
      )
    ),
    paragraph(
      text(
        "Access follows the ticket: anyone who can reply can join, light agents can watch but not type, and every join and ownership change lands in the ticket’s audit log."
      )
    ),
    heading("Success Metrics"),
    bullets(
      [
        text(
          "Median escalation handoff under 5 minutes by the end of the beta."
        ),
      ],
      [
        text(
          "At least 30% of escalations on beta accounts use a shared draft within four weeks."
        ),
      ],
      [
        text(
          "No rise in replies sent by the wrong owner, checked weekly by support operations."
        ),
      ],
      [
        text(
          "Satisfaction on shared replies at or above the team average of 91%."
        ),
      ]
    ),
    heading("Rollout"),
    numbered(
      [text("October 28: private beta for 40 accounts, English only.")],
      [
        text(
          "November 4: every Growth and Scale workspace, behind a workspace setting."
        ),
      ],
      [
        text(
          "November 18: general availability, on by default for new workspaces."
        ),
      ]
    ),
    heading("Risks"),
    paragraph(
      text(
        "Two agents can still promise different things in different paragraphs. The composer shows who changed each paragraph last, and the owner reads the whole draft before sending."
      )
    ),
    paragraph(
      text(
        "Offline merges never conflict at the text level, but edits that land in a burst on reconnect can surprise the owner. Merged paragraphs stay marked for ten seconds after a sync."
      )
    ),
    heading("Open Questions"),
    bullets(
      [
        text(
          "Does a shared reply count toward both agents’ response time targets?"
        ),
      ],
      [
        text(
          "Should the draft lock once the owner opens the send confirmation?"
        ),
      ],
      [
        text("Do we show live cursors to "),
        commented("agents on the free plan", "t-free"),
        text("?"),
      ]
    ),
    heading("Launch Checklist"),
    {
      type: "taskList",
      content: [
        task(true, "Presence row design review"),
        task(false, "Load test the gateway at 3,000 concurrent drafts"),
        task(false, "Macro audit with support operations"),
        task(false, "Help center article and in-app tour"),
      ],
    },
    paragraph(
      text("Owner: Arjun Mehta. Engineering: Lena Hoffmann. Launch: Maya Chen.")
    ),
  ],
}

/** Open discussions; each id matches a comment mark in SPEC. */
export const THREADS: ThreadSeed[] = [
  {
    id: "t-handoff",
    author: "daniel",
    createdAt: "2026-09-25T16:40:00.000Z",
    messages: [
      {
        author: "daniel",
        body: "These numbers come from the August export. Is queue wait counted once here, or twice?",
        at: "2026-09-25T16:40:00.000Z",
      },
    ],
  },
  {
    id: "t-owner",
    author: "maya",
    createdAt: "2026-09-26T09:12:00.000Z",
    messages: [
      {
        author: "maya",
        body: "What does the teammate see if the owner goes offline halfway through?",
        at: "2026-09-26T09:12:00.000Z",
      },
      {
        author: "arjun",
        body: "They can request ownership after two minutes. I will spell out the timeout here.",
        at: "2026-09-26T10:05:00.000Z",
      },
    ],
  },
  {
    id: "t-free",
    author: "daniel",
    createdAt: "2026-09-26T11:30:00.000Z",
    messages: [
      {
        author: "daniel",
        body: "Pricing needs this settled before the beta invite list goes out.",
        at: "2026-09-26T11:30:00.000Z",
      },
    ],
  },
]

/** The live session, staged above the fold: where each teammate types,
 * selects and comments. Every anchor is a plain run of SPEC text. */
export const PEER_TRACKS: PeerTrack[] = [
  {
    peer: "maya",
    startAt: 1200,
    steps: [
      { kind: "status", status: "editing" },
      { kind: "caret", phrase: "on November 18." },
      {
        kind: "type",
        text: " A private beta opens to 40 accounts on October 28.",
      },
      { kind: "pause", ms: 1400 },
      { kind: "select", phrase: "named cursors" },
      { kind: "pause", ms: 2200 },
      {
        kind: "comment",
        phrase: "named cursors",
        thread: "t-cursors",
        body: "Admins read cursor as jargon. Could this say who is typing instead?",
      },
      { kind: "caret", phrase: "named cursors" },
      { kind: "pause", ms: 3200 },
      { kind: "status", status: "idle" },
    ],
  },
  {
    peer: "lena",
    startAt: 3400,
    steps: [
      { kind: "status", status: "editing" },
      { kind: "caret", phrase: "to under 5" },
      { kind: "type", text: ", measured from invite to send" },
      { kind: "pause", ms: 900 },
      {
        kind: "reply",
        thread: "t-handoff",
        ms: 2600,
        body: "Checked the gateway logs. Queue wait is counted once, so 14 minutes holds.",
      },
      { kind: "pause", ms: 1200 },
      { kind: "select", phrase: "under 5" },
      { kind: "pause", ms: 1800 },
      // Parked inside the line: a caret at a line's end makes ProseMirror
      // add a separator image with no src.
      { kind: "caret", phrase: "under 5" },
      { kind: "pause", ms: 2600 },
      { kind: "status", status: "idle" },
    ],
  },
]

/** Played once, the first time you go offline after the session settles, so
 * the reconnect has a teammate's edit to merge. */
export const OFFLINE_TRACK: PeerTrack = {
  peer: "lena",
  startAt: 1600,
  steps: [
    { kind: "status", status: "editing" },
    { kind: "check", phrase: "3,000 concurrent drafts" },
    { kind: "caret", phrase: "3,000 concurrent drafts" },
    { kind: "type", text: ", passed at 3,400" },
    { kind: "pause", ms: 1800 },
    { kind: "caret", phrase: "passed at" },
    { kind: "status", status: "idle" },
  ],
}