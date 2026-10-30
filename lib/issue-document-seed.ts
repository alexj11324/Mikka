import type { Schema } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/react'

export const EMPTY_DOCUMENT: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }

const warned = new Set<string>()

/** Stored issue content can be malformed; seed an empty document instead of crashing the page. */
export function seedableContent(schema: Schema, content: unknown, issueId: string): JSONContent {
  try {
    if (content && typeof content === 'object' && (content as { type?: unknown }).type === 'doc') {
      schema.nodeFromJSON(content).check()
      return content as JSONContent
    }
  } catch {}
  if (!warned.has(issueId)) {
    warned.add(issueId)
    console.warn(`Issue ${issueId} has invalid content; opened as an empty document`)
  }
  return EMPTY_DOCUMENT
}
