import type { JSONContent } from "@tiptap/react"

import { SUGGESTION_DELETE, SUGGESTION_INSERT } from "./rich-text-changes"

export type PersonId = "sofia" | "priya" | "daniel"

export interface Person {
  id: PersonId
  name: string
  initials: string
  avatar: string
}

export const PEOPLE: Person[] = [
  {
    id: "sofia",
    name: "Sofia Marques",
    initials: "SM",
    avatar:
      "https://images.unsplash.com/photo-1517841905240-472988babdf9?w=96&h=96&dpr=2&q=80",
  },
  {
    id: "priya",
    name: "Priya Raman",
    initials: "PR",
    avatar:
      "https://images.unsplash.com/photo-1488426862026-3ee34a7d66df?w=96&h=96&dpr=2&q=80",
  },
  {
    id: "daniel",
    name: "Daniel Okafor",
    initials: "DO",
    avatar:
      "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=96&h=96&dpr=2&q=80",
  },
]

/** The signed-in reviewer: new suggestions carry this author. */
export const CURRENT_AUTHOR: PersonId = "sofia"

const DEMO_NOW = "2026-09-26T15:00:00.000Z"

/** The one clock: it stamps new suggestions and anchors "Just now".
 * customize: return the real time as an ISO string instead of the demo date. */
export function currentTime() {
  return DEMO_NOW
}

export const CONTRACT_META = {
  title: "Master Services Agreement",
  counterparty: "Halden Freight",
  round: 3,
  // Sofia's last seeded suggestion.
  editedAt: "2026-09-26T09:30:00.000Z",
}

type Suggestion = { id: string; author: PersonId; time: string }

const PAYMENT: Suggestion = {
  id: "s-payment",
  author: "priya",
  time: "2026-09-25T14:05:00.000Z",
}
const RENEWAL: Suggestion = {
  id: "s-renewal",
  author: "priya",
  time: "2026-09-25T14:12:00.000Z",
}
const BREACH: Suggestion = {
  id: "s-breach",
  author: "priya",
  time: "2026-09-25T14:20:00.000Z",
}
const LIABILITY: Suggestion = {
  id: "s-liability",
  author: "priya",
  time: "2026-09-25T14:31:00.000Z",
}
const CONVENIENCE: Suggestion = {
  id: "s-convenience",
  author: "priya",
  time: "2026-09-25T14:44:00.000Z",
}
const RESPONSE: Suggestion = {
  id: "s-response",
  author: "daniel",
  time: "2026-09-25T16:40:00.000Z",
}
const BETA: Suggestion = {
  id: "s-beta",
  author: "sofia",
  time: "2026-09-26T09:12:00.000Z",
}
const MAINTENANCE: Suggestion = {
  id: "s-maintenance",
  author: "sofia",
  time: "2026-09-26T09:30:00.000Z",
}

function text(value: string): JSONContent {
  return { type: "text", text: value }
}

function bold(value: string): JSONContent {
  return { type: "text", text: value, marks: [{ type: "bold" }] }
}

function inserted(value: string, suggestion: Suggestion): JSONContent {
  return {
    type: "text",
    text: value,
    marks: [{ type: SUGGESTION_INSERT, attrs: suggestion }],
  }
}

function deleted(value: string, suggestion: Suggestion): JSONContent {
  return {
    type: "text",
    text: value,
    marks: [{ type: SUGGESTION_DELETE, attrs: suggestion }],
  }
}

function heading(value: string): JSONContent {
  return { type: "heading", attrs: { level: 2 }, content: [text(value)] }
}

function clause(number: string, ...content: JSONContent[]): JSONContent {
  return { type: "paragraph", content: [bold(number), text(" "), ...content] }
}

// Seeded marks load with the document, so no transaction runs at mount.
export const CONTRACT: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        text(
          "This Master Services Agreement (the “Agreement”) is made as of October 1, 2026 (the “Effective Date”) between Kestrel Works Inc., the provider of Loomwell (“Kestrel”), and Halden Freight LLC (“Customer”). It governs Customer’s use of the Services under every Order Form the parties sign."
        ),
      ],
    },
    heading("1. Definitions"),
    clause(
      "1.1",
      text(
        "“Services” means the Loomwell shared inbox, its mobile apps and the APIs described in the Documentation"
      ),
      deleted(", including any beta or preview features", BETA),
      text(
        ". Beta features are offered as is and are excluded from the service levels in Section 2."
      )
    ),
    clause(
      "1.2",
      text(
        "“Customer Data” means all messages, attachments, contact records and other content that Customer or its Authorized Users submit to the Services. “Authorized Users” means Customer’s employees and contractors who hold a seat under an active Order Form."
      )
    ),
    heading("2. Services and Support"),
    clause(
      "2.1",
      text(
        "Kestrel will make the Services available 99.9% of the time in each calendar month"
      ),
      inserted(
        ", excluding scheduled maintenance announced at least 48 hours in advance",
        MAINTENANCE
      ),
      text(
        ". If availability falls below that level, Customer may claim the service credits set out in the Support Policy."
      )
    ),
    clause(
      "2.2",
      text("Kestrel will respond to Priority 1 tickets within "),
      deleted("one (1) business day", RESPONSE),
      inserted("four (4) business hours", RESPONSE),
      text(
        " and to all other tickets within two (2) business days. Support is provided in English by email and inside the product."
      )
    ),
    heading("3. Fees and Payment"),
    clause(
      "3.1",
      text(
        "Customer will pay the Fees listed in each Order Form. Kestrel invoices annually in advance, and each invoice is due within "
      ),
      deleted("thirty (30)", PAYMENT),
      inserted("forty-five (45)", PAYMENT),
      text(" days of the invoice date.")
    ),
    clause(
      "3.2",
      text(
        "Late amounts accrue interest at 1% per month or the highest rate the law allows, whichever is lower. Fees exclude taxes, which Customer pays except for taxes on Kestrel’s income."
      )
    ),
    heading("4. Term and Renewal"),
    clause(
      "4.1",
      text(
        "This Agreement starts on the Effective Date and continues until every Order Form has expired or been terminated. Each Order Form has an initial Subscription Term of twelve (12) months."
      )
    ),
    clause(
      "4.2",
      deleted(
        "Each Subscription Term renews automatically for successive twelve (12) month periods unless either party gives notice of non-renewal at least sixty (60) days before it ends. ",
        RENEWAL
      ),
      text(
        "Kestrel will notify Customer of any price change at least ninety (90) days before a new Subscription Term begins."
      )
    ),
    heading("5. Data Protection"),
    clause(
      "5.1",
      text(
        "Kestrel will process Customer Data only to provide the Services and as Customer instructs in writing, under the Data Processing Addendum attached as Exhibit B. Kestrel keeps Customer Data encrypted in transit and at rest."
      )
    ),
    clause(
      "5.2",
      text(
        "Kestrel will notify Customer of any confirmed Security Incident affecting Customer Data within "
      ),
      deleted("seventy-two (72) hours", BREACH),
      inserted("forty-eight (48) hours", BREACH),
      text(
        " of confirming it, and will share the facts Customer needs to meet its own notice duties."
      )
    ),
    heading("6. Limitation of Liability"),
    clause(
      "6.1",
      text(
        "Except for breaches of Section 5 and a party’s indemnity obligations, each party’s total liability under this Agreement is capped at the Fees paid or payable in the "
      ),
      deleted("twelve (12)", LIABILITY),
      inserted("twenty-four (24)", LIABILITY),
      text(" months before the event giving rise to the claim.")
    ),
    clause(
      "6.2",
      text(
        "Neither party is liable for lost profits, lost revenue or indirect, special or consequential damages, even if it was told such damages were possible."
      )
    ),
    heading("7. Termination"),
    clause(
      "7.1",
      text(
        "Either party may terminate this Agreement if the other materially breaches it and fails to cure the breach within thirty (30) days of written notice."
      ),
      inserted(
        " Customer may also terminate for convenience on ninety (90) days’ written notice, with a pro rata refund of any prepaid Fees for the remaining Subscription Term.",
        CONVENIENCE
      )
    ),
    clause(
      "7.2",
      text(
        "On termination, Kestrel will make Customer Data available for export for thirty (30) days and then delete it from production systems within a further sixty (60) days."
      )
    ),
    heading("8. General"),
    clause(
      "8.1",
      text(
        "This Agreement is governed by the laws of the Province of Ontario and the federal laws of Canada that apply there. The courts of Toronto have exclusive jurisdiction over any dispute."
      )
    ),
    clause(
      "8.2",
      text(
        "Neither party may assign this Agreement without the other’s written consent, except to a successor in a merger or a sale of substantially all of its assets."
      )
    ),
  ],
}