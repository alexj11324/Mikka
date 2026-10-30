import type { Schema } from '@tiptap/pm/model'
import type { JSONContent } from '@tiptap/core'
import { prosemirrorJSONToYDoc } from '@tiptap/y-tiptap'
import * as Y from 'yjs'

export const EMPTY_DOCUMENT: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] }
export const WARNED_ISSUE_LIMIT = 200
const warned = new Set<string>()

function warnOnce(issueId: string) {
  if (warned.has(issueId)) return
  // Bounded: evict the oldest id so a long-lived tab or server never grows this set without limit.
  if (warned.size >= WARNED_ISSUE_LIMIT) warned.delete(warned.values().next().value as string)
  warned.add(issueId)
  console.warn(`Issue ${issueId} has invalid content; opened read-only`)
}
export function warnedIssueCount() { return warned.size }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
// ProseMirror rejects `text: ''`; dropping only those nodes keeps the rest of the document.
function dropEmptyText(node: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(node.content)) return node
  return { ...node, content: node.content.filter(child => !(isRecord(child) && child.type === 'text' && child.text === '')).map(child => isRecord(child) ? dropEmptyText(child) : child) }
}

/** Sanitized content that the schema accepts, or null when it cannot be rendered safely. */
export function readIssueContent(schema: Schema, content: unknown, issueId?: string): JSONContent | null {
  try {
    if (isRecord(content) && content.type === 'doc') {
      let clean = dropEmptyText(content)
      if (!Array.isArray(clean.content) || clean.content.length === 0) clean = { ...clean, content: EMPTY_DOCUMENT.content }
      schema.nodeFromJSON(clean).check()
      return clean as JSONContent
    }
  } catch {}
  if (issueId) warnOnce(issueId)
  return null
}

/** Yjs seed for content that passed validation, or null: the caller must then send no seed and stay read-only. */
export function issueDocumentSeed(schema: Schema, content: unknown, issueId: string): Uint8Array | null {
  const clean = readIssueContent(schema, content, issueId)
  if (!clean) return null
  let doc: Y.Doc | undefined
  try {
    // Inside the try: deeply nested documents overflow the stack here, not in validation.
    doc = prosemirrorJSONToYDoc(schema, clean, 'default')
    return Y.encodeStateAsUpdate(doc)
  } catch {
    warnOnce(issueId)
    return null
  } finally {
    doc?.destroy()
  }
}
