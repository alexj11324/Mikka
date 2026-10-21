import type { JSONContent } from '@tiptap/react'

/** One line of a list item's own text, without the marker. */
function inlineText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? ''
  return (node.content ?? []).map(inlineText).join('')
}

/**
 * A TipTap document as plain text: what an agent's brief shows. Headings and
 * paragraphs keep their breaks, list items get a marker, code blocks keep
 * their fences, so the prompt reads the way the issue does.
 */
export function tiptapToText(doc: JSONContent | null | undefined): string {
  if (!doc) return ''
  const blocks: string[] = []
  for (const node of doc.content ?? []) {
    if (node.type === 'heading') {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 6)
      blocks.push(`${'#'.repeat(level)} ${inlineText(node)}`.trim())
    } else if (node.type === 'codeBlock') {
      blocks.push(`\`\`\`\n${inlineText(node)}\n\`\`\``)
    } else if (node.type === 'bulletList' || node.type === 'orderedList') {
      const ordered = node.type === 'orderedList'
      blocks.push((node.content ?? []).map((item, index) => `${ordered ? `${index + 1}.` : '-'} ${inlineText(item).trim()}`).join('\n'))
    } else if (node.type === 'blockquote') {
      blocks.push(inlineText(node).split('\n').map(line => `> ${line}`).join('\n'))
    } else {
      const text = inlineText(node).trim()
      if (text) blocks.push(text)
    }
  }
  return blocks.join('\n\n').trim()
}
