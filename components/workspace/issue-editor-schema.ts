import { getSchema } from '@tiptap/core'
import type { Schema } from '@tiptap/pm/model'
import { createRichTextExtensions } from '@/components/blocks/rich-text-editor-2/components/rich-text-extensions'
import { RichTextBlockActions } from '@/components/blocks/rich-text-editor-2/components/rich-text-block-actions'
import { RichTextSlashCommand, RICH_TEXT_BASIC_SLASH_ITEMS } from '@/components/blocks/rich-text-editor-2/components/rich-text-slash-menu'
import { RichTextOutlineBlock, RICH_TEXT_OUTLINE_SLASH_ITEM } from '@/components/blocks/rich-text-editor-2/components/rich-text-outline-node'
import { RichTextTable, RICH_TEXT_TABLE_SLASH_ITEM } from '@/components/blocks/rich-text-editor-2/components/rich-text-table'
import { createRichTextMention } from '@/components/blocks/rich-text-editor-2/components/rich-text-mention'
import { RichTextChanges } from '@/components/blocks/rich-text-editor-3/components/rich-text-changes'
import { CommentMark, CommentPaint } from '@/components/blocks/rich-text-editor-4/components/rich-text-comments'
import { issueDocumentSeed, readIssueContent } from '@/lib/issue-document-seed'

export function createEditorExtensions(isOpen: (id: string) => boolean, author: string, collaborative: boolean, compact = false, placeholder = '') {
  return [
    ...createRichTextExtensions({ placeholder, collaborative }),
    RichTextBlockActions, RichTextTable, RichTextOutlineBlock, createRichTextMention([]),
    RichTextSlashCommand.configure({ items: [...RICH_TEXT_BASIC_SLASH_ITEMS, RICH_TEXT_TABLE_SLASH_ITEM, RICH_TEXT_OUTLINE_SLASH_ITEM] }),
    RichTextChanges.configure({ author, tracking: false, now: () => new Date().toISOString() }),
    CommentMark, CommentPaint.configure({ isOpen }),
  ]
}

let schema: Schema | undefined
/** The issue editor's real schema (shared by the client seed and the server guards). */
export function issueEditorSchema() {
  return schema ??= getSchema(createEditorExtensions(() => false, 'seed', true))
}
export function createDocumentSeed(content: unknown, issueId: string) {
  return issueDocumentSeed(issueEditorSchema(), content, issueId)
}
export function readableIssueContent(content: unknown, issueId?: string) {
  return readIssueContent(issueEditorSchema(), content, issueId)
}
