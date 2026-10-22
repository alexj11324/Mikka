import { Mark, mergeAttributes } from '@tiptap/core'

export const COMMENT_MARK = 'comment'
export const THREADS_FIELD = 'threads'

export const CommentMark = Mark.create({
  name: COMMENT_MARK,
  inclusive: false,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: element => element.getAttribute('data-comment-id'),
        renderHTML: attributes => attributes.id ? { 'data-comment-id': attributes.id } : {},
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-comment-id]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0]
  },
})
