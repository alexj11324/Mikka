import type { JSONContent } from '@tiptap/core'

function escapeMarkdown(value: string) {
  return value.replace(/([\\`*_{}[\]<>])/g, '\\$1')
}

function inlineToMarkdown(node: JSONContent): string {
  if (node.type === 'hardBreak') return '  \n'
  if (node.type !== 'text') return (node.content ?? []).map(inlineToMarkdown).join('')
  let value = escapeMarkdown(node.text ?? '')
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') value = `**${value}**`
    else if (mark.type === 'italic') value = `*${value}*`
    else if (mark.type === 'strike') value = `~~${value}~~`
    else if (mark.type === 'code') value = `\`${node.text ?? ''}\``
    else if (mark.type === 'link' && typeof mark.attrs?.href === 'string' && /^(https?:|mailto:)/i.test(mark.attrs.href)) value = `[${value}](${mark.attrs.href})`
  }
  return value
}

function listMarkdown(node: JSONContent, depth = 0): string {
  const ordered = node.type === 'orderedList'
  const start = Number(node.attrs?.start) || 1
  return (node.content ?? []).map((item, index) => {
    const prefix = ordered ? `${start + index}. ` : '- '
    const first = (item.content ?? []).find(child => child.type === 'paragraph')
    const text = (first?.content ?? []).map(inlineToMarkdown).join('')
    const nested = (item.content ?? []).filter(child => child.type === 'bulletList' || child.type === 'orderedList').map(child => listMarkdown(child, depth + 1)).join('\n')
    const pad = '  '.repeat(depth)
    return `${pad}${prefix}${text}${nested ? `\n${nested}` : ''}`
  }).join('\n')
}

export function issueContentToMarkdown(doc: JSONContent | null | undefined) {
  if (!doc) return ''
  return (doc.content ?? []).map(node => {
    if (node.type === 'heading') return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.attrs?.level) || 1)))} ${(node.content ?? []).map(inlineToMarkdown).join('')}`
    if (node.type === 'bulletList' || node.type === 'orderedList') return listMarkdown(node)
    if (node.type === 'taskList') return (node.content ?? []).map(item => `- [${item.attrs?.checked ? 'x' : ' '}] ${(item.content ?? []).flatMap(child => child.content ?? []).map(inlineToMarkdown).join('')}`).join('\n')
    if (node.type === 'codeBlock') return `\`\`\`${typeof node.attrs?.language === 'string' ? node.attrs.language : ''}\n${(node.content ?? []).map(item => item.text ?? '').join('')}\n\`\`\``
    if (node.type === 'blockquote') return (node.content ?? []).map(child => (child.content ?? []).map(inlineToMarkdown).join('')).join('\n').split('\n').map(line => `> ${line}`).join('\n')
    if (node.type === 'horizontalRule') return '---'
    return (node.content ?? []).map(inlineToMarkdown).join('')
  }).filter(Boolean).join('\n\n')
}

type Mark = NonNullable<JSONContent['marks']>[number]
function inlineFromMarkdown(value: string): JSONContent[] {
  const nodes: JSONContent[] = []
  const append = (text: string, marks: Mark[] = []) => {
    if (!text) return
    const last = nodes.at(-1)
    if (last?.type === 'text' && JSON.stringify(last.marks ?? []) === JSON.stringify(marks)) last.text = `${last.text ?? ''}${text}`
    else nodes.push({ type: 'text', text, ...(marks.length ? { marks } : {}) })
  }
  const parse = (text: string, marks: Mark[] = []) => {
    while (text) {
      const link = text.match(/^\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/i)
      if (link) { parse(link[1]!, [...marks, { type: 'link', attrs: { href: link[2] } }]); text = text.slice(link[0].length); continue }
      const code = text.match(/^`([^`]+)`/)
      if (code) { append(code[1]!, [...marks, { type: 'code' }]); text = text.slice(code[0].length); continue }
      const bold = text.match(/^\*\*(.+?)\*\*/)
      if (bold) { parse(bold[1]!, [...marks, { type: 'bold' }]); text = text.slice(bold[0].length); continue }
      const strike = text.match(/^~~(.+?)~~/)
      if (strike) { parse(strike[1]!, [...marks, { type: 'strike' }]); text = text.slice(strike[0].length); continue }
      const italic = text.match(/^\*([^*]+)\*/)
      if (italic) { parse(italic[1]!, [...marks, { type: 'italic' }]); text = text.slice(italic[0].length); continue }
      const escaped = text.match(/^\\([\\`*_{}[\]<>()~#+.\-=!|>])/)
      if (escaped) { append(escaped[1]!, marks); text = text.slice(escaped[0].length); continue }
      const next = text.slice(1).search(/\\|\[|`|\*|~/)
      const length = next === -1 ? text.length : next + 1
      append(text.slice(0, length), marks)
      text = text.slice(length)
    }
  }
  parse(value)
  return nodes
}

function inlineParagraphFromMarkdown(lines: string[]) {
  return lines.flatMap((line, index) => {
    const hasNext = index < lines.length - 1
    const hardBreak = hasNext && /(?: {2,}|\\)$/.test(line)
    const value = hardBreak ? line.replace(/(?: {2,}|\\)$/, '') : line
    const text = value.replace(/^\s+/, '')
    return [
      ...inlineFromMarkdown(text),
      ...(hasNext ? [hardBreak ? { type: 'hardBreak' } : { type: 'text', text: ' ' }] : []),
    ]
  })
}

const listLine = (line: string) => line.match(/^(\s*)([-*+] |\d+[.)] )(.*)$/)
const startsBlock = (line: string) => /^\s{0,3}(?:#{1,6}\s|```|>|[-*+] |\d+[.)] |---\s*$)/.test(line)

export function linearMarkdownToIssueContent(markdown: string | null | undefined): JSONContent {
  const lines = (markdown ?? '').replace(/\r/g, '').split('\n')
  const content: JSONContent[] = []
  let index = 0
  while (index < lines.length) {
    while (index < lines.length && !lines[index]!.trim()) index++
    if (index >= lines.length) break
    const line = lines[index]!
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/)
    if (heading) { content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inlineFromMarkdown(heading[2]!) }); index++; continue }
    if (/^\s{0,3}```/.test(line)) {
      const language = line.trim().slice(3).trim()
      const code: string[] = []
      index++
      while (index < lines.length && !/^\s{0,3}```/.test(lines[index]!)) code.push(lines[index++]!)
      if (index < lines.length) index++
      content.push({ type: 'codeBlock', attrs: { language: language || null }, content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] })
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const quote: string[] = []
      while (index < lines.length && /^\s{0,3}>/.test(lines[index]!)) quote.push(lines[index++]!.replace(/^\s{0,3}> ?/, ''))
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineFromMarkdown(quote.join(' ')) }] })
      continue
    }
    if (line.trim() === '---') { content.push({ type: 'horizontalRule' }); index++; continue }
    const firstList = listLine(line)
    if (firstList) {
      const indent = firstList[1]!.length
      const ordered = /^\d/.test(firstList[2]!)
      const firstTask = /^\[([ xX])\]\s+/.test(firstList[3]!)
      const items: JSONContent[] = []
      while (index < lines.length) {
        const match = listLine(lines[index]!)
        if (!match || match[1]!.length !== indent || /^\d/.test(match[2]!) !== ordered) break
        let text = match[3]!
        const task = text.match(/^\[([ xX])\]\s+(.*)$/)
        if (Boolean(task) !== firstTask) break
        if (task) text = task[2]!
        index++
        while (index < lines.length && /^\s+\S/.test(lines[index]!) && !listLine(lines[index]!)) text += ` ${lines[index++]!.trim()}`
        items.push({ type: firstTask ? 'taskItem' : 'listItem', ...(task ? { attrs: { checked: task[1]!.toLowerCase() === 'x' } } : {}), content: [{ type: 'paragraph', content: inlineFromMarkdown(text) }] })
      }
      content.push({ type: firstTask ? 'taskList' : ordered ? 'orderedList' : 'bulletList', content: items })
      continue
    }
    const paragraph = [line]
    index++
    while (index < lines.length && lines[index]!.trim() && !startsBlock(lines[index]!)) paragraph.push(lines[index++]!)
    content.push({ type: 'paragraph', content: inlineParagraphFromMarkdown(paragraph) })
  }
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] }
}

export function linearMarkdownToPlainText(markdown: string | null | undefined) {
  const walk = (node: JSONContent): string => node.type === 'text' ? node.text ?? '' : node.type === 'hardBreak' ? '\n' : (node.content ?? []).map(walk).join(node.type === 'paragraph' || node.type === 'heading' ? '' : '\n')
  return (linearMarkdownToIssueContent(markdown).content ?? []).map(walk).join('\n\n').trim()
}

export function plainTextToLinearMarkdown(value: string) {
  const escape = (line: string) => line.replace(/([\\`*_{}[\]().<>~#+\-=!|])/g, '\\$1')
  return value.split(/\n{2,}/).map(paragraph => paragraph.split('\n').map(escape).join('  \n')).join('\n\n')
}
