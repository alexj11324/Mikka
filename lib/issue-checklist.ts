import type { JSONContent } from '@tiptap/core'

export function issueChecklist(content: JSONContent) {
  let total = 0
  let checked = 0
  function visit(node: JSONContent) {
    if (node.type === 'taskItem') {
      total++
      if (node.attrs?.checked === true) checked++
    }
    node.content?.forEach(visit)
  }
  visit(content)
  return { total, checked, percentage: total ? Math.round(checked / total * 100) : 0 }
}
