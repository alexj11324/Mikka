import type { JSONContent } from "@tiptap/react"

export interface Person {
  id: string
  name: string
  avatar: string
  role: string
  initials: string
}

export const PAGE_META = {
  title: "Escalation Playbook",
  space: "Support wiki",
  editedAt: "2026-09-26",
} as const

export const PEOPLE: Person[] = [
  {
    id: "usr_daniel",
    name: "Daniel Okafor",
    avatar:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&dpr=2&q=80",
    role: "Support operations manager",
    initials: "DO",
  },
  {
    id: "usr_lena",
    name: "Lena Hoffmann",
    avatar:
      "https://images.unsplash.com/photo-1438761681033-6461ffad8d80?w=96&h=96&dpr=2&q=80",
    role: "Engineering manager, search",
    initials: "LH",
  },
  {
    id: "usr_maya",
    name: "Maya Chen",
    avatar:
      "https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=96&h=96&dpr=2&q=80",
    role: "Product marketing lead",
    initials: "MC",
  },
  {
    id: "usr_arjun",
    name: "Arjun Mehta",
    avatar:
      "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?w=96&h=96&dpr=2&q=80",
    role: "Product designer",
    initials: "AM",
  },
]

type Mark = NonNullable<JSONContent["marks"]>[number]

const bold: Mark = { type: "bold" }
const code: Mark = { type: "code" }
const highlight: Mark = { type: "highlight", attrs: { color: "yellow" } }

function link(href: string): Mark {
  return { type: "link", attrs: { href } }
}

function text(value: string, ...marks: Mark[]): JSONContent {
  return marks.length
    ? { type: "text", text: value, marks }
    : { type: "text", text: value }
}

function personName(personId: Person["id"]) {
  return PEOPLE.find((entry) => entry.id === personId)?.name ?? personId
}

function mention(personId: Person["id"]): JSONContent {
  return {
    type: "mention",
    attrs: { id: personId, label: personName(personId) },
  }
}

function paragraph(...content: JSONContent[]): JSONContent {
  return { type: "paragraph", content }
}

function heading(level: 1 | 2 | 3, value: string): JSONContent {
  return { type: "heading", attrs: { level }, content: [text(value)] }
}

function item(...content: JSONContent[]): JSONContent {
  return { type: "listItem", content: [paragraph(...content)] }
}

function task(checked: boolean, ...content: JSONContent[]): JSONContent {
  return {
    type: "taskItem",
    attrs: { checked },
    content: [paragraph(...content)],
  }
}

function cell(type: "tableHeader" | "tableCell", ...content: JSONContent[]) {
  return { type, content: [paragraph(...content)] } satisfies JSONContent
}

// customize: the tier table; owners are people ids, shown by name
const TIERS = [
  { tier: "Tier 1", owner: "usr_daniel", target: "4 business hours" },
  { tier: "Tier 2", owner: "usr_lena", target: "1 hour" },
  { tier: "Tier 3", owner: "usr_lena", target: "15 minutes" },
] as const

const CHANNELS: Record<(typeof TIERS)[number]["tier"], string> = {
  "Tier 1": "#support-desk",
  "Tier 2": "#search-oncall",
  "Tier 3": "#incident-room",
}

/** A playbook mid review: two handoff steps done, three open. */
export const PAGE: JSONContent = {
  type: "doc",
  content: [
    heading(1, "Escalation Playbook"),
    paragraph(
      text(
        "How Loomwell support hands a customer problem to engineering without losing context. "
      ),
      mention("usr_daniel"),
      text(" owns this page; propose edits in "),
      text("#support-ops", code),
      text(".")
    ),
    { type: "richTextOutline" },
    heading(2, "When to Escalate"),
    paragraph(
      text(
        "Escalate as soon as one of these is true. When in doubt, escalate and let the next tier downgrade it."
      )
    ),
    {
      type: "bulletList",
      content: [
        item(
          text("Email stops syncing for a workspace for more than 15 minutes.")
        ),
        item(
          text(
            "Inbox search misses conversations that exist, for more than one agent."
          )
        ),
        item(text("Scheduled replies send at the wrong time, or not at all.")),
        item(
          text("Anything that looks like another workspace's data is "),
          text("always Tier 3", bold),
          text(".")
        ),
      ],
    },
    heading(2, "Escalation Tiers"),
    paragraph(
      text(
        "Targets run from the moment the ticket is tagged, around the clock for Tier 3."
      )
    ),
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: ["Tier", "Owner", "Response target", "Channel"].map(
            (label) => cell("tableHeader", text(label))
          ),
        },
        ...TIERS.map((row) => ({
          type: "tableRow",
          content: [
            cell("tableCell", text(row.tier)),
            cell("tableCell", text(personName(row.owner))),
            cell("tableCell", text(row.target)),
            cell("tableCell", text(CHANNELS[row.tier], code)),
          ],
        })),
      ],
    },
    heading(3, "Paging Engineering"),
    paragraph(
      text(
        "Tier 2 and Tier 3 page the search on-call from the incident channel. Never message an engineer directly: "
      ),
      text("the page is what starts the clock", highlight),
      text(".")
    ),
    heading(2, "Handoff Checklist"),
    {
      type: "taskList",
      content: [
        task(
          true,
          text("Tag the ticket with its tier and the affected workspace ID")
        ),
        task(
          true,
          text("Reproduce it on a staging workspace, or note why you could not")
        ),
        task(false, text("Paste the search diagnostics from the next section")),
        task(
          false,
          text("Agree the customer update with "),
          mention("usr_maya"),
          text(" before it goes out")
        ),
        task(
          false,
          text("Book the incident review with "),
          mention("usr_lena"),
          text(" once Tier 3 closes")
        ),
      ],
    },
    heading(2, "Handoff Note"),
    heading(3, "Search Diagnostics"),
    paragraph(
      text(
        "Run this from the admin console and paste the output in the ticket:"
      )
    ),
    {
      type: "codeBlock",
      content: [text("loomwell diag search --workspace ws_4821 --since 2h")],
    },
    heading(3, "Customer Updates"),
    paragraph(
      text(
        "Send the first update inside the response target, even with nothing new to say. The tone we aim for:"
      )
    ),
    {
      type: "blockquote",
      content: [
        paragraph(
          text(
            "We can see the problem on our side and an engineer is on it now. You will hear from us again by 3:00 p.m. UTC, sooner if it is fixed."
          )
        ),
      ],
    },
    heading(2, "Review Cadence"),
    paragraph(
      text("Every Tier 3 gets a written review within five business days. "),
      mention("usr_arjun"),
      text(" collects the notes, and past reviews live in the "),
      text("incident archive", link("https://loomwell.example/reviews")),
      text(".")
    ),
  ],
}