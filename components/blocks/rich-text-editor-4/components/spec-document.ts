import { getSchema, type AnyExtension } from "@tiptap/react"
import { StarterKit } from "@tiptap/starter-kit"
import { prosemirrorJSONToYXmlFragment } from "@tiptap/y-tiptap"
import * as Y from "yjs"

import { SPEC, THREADS } from "./data"
import { CommentMark, seedThreads } from "./rich-text-comments"
import { createRichTextExtensions } from "./rich-text-extensions"

// A spec needs neither: a highlight reads as a comment anchor, and no control
// sets alignment, so their keys and markdown rules go with them.
const LEFT_OUT = new Set(["highlight", "textAlign"])

/** The kit preset with StarterKit's history off (Collaboration brings a Yjs
 * undo that only reverts your own edits), plus the comment anchor. */
export const SPEC_EXTENSIONS: AnyExtension[] = [
  ...createRichTextExtensions({
    placeholder: "Write, or wait for a teammate",
  })
    .filter((extension) => !LEFT_OUT.has(extension.name))
    .map((extension) =>
      extension.name === "starterKit"
        ? (extension as typeof StarterKit).configure({ undoRedo: false })
        : extension
    ),
  CommentMark,
]

/** Collaboration binds this field of the shared Y.Doc. */
export const SPEC_FIELD = "default"

const SEED_CLIENT_ID = 10

let seed: Uint8Array | null = null

/** One binary seed applied to every client, so the text exists once; seeding
 * each doc (or passing `content`) would duplicate it on the first sync. */
export function getSeedUpdate() {
  if (seed) return seed
  const doc = new Y.Doc()
  doc.clientID = SEED_CLIENT_ID
  // The editor's exact schema, or its first render rewrites the seed.
  prosemirrorJSONToYXmlFragment(
    getSchema(SPEC_EXTENSIONS),
    SPEC,
    doc.getXmlFragment(SPEC_FIELD)
  )
  doc.transact(() => seedThreads(doc, THREADS))
  seed = Y.encodeStateAsUpdate(doc)
  doc.destroy()
  return seed
}