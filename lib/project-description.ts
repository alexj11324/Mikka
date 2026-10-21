import type { JSONContent } from '@tiptap/react'

export function readProjectDescription(value: string): JSONContent {
  try {
    const document: unknown = JSON.parse(value)
    if (document && typeof document === 'object' && 'type' in document && document.type === 'doc' && 'content' in document && Array.isArray(document.content)) return document as JSONContent
  } catch {
    // Existing projects store plain text; keep each line as an editable paragraph.
  }
  return { type: 'doc', content: value.split('\n').map(text => ({ type: 'paragraph', ...(text ? { content: [{ type: 'text', text }] } : {}) })) }
}
