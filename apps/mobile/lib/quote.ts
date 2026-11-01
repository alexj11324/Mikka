import { splitOpenUI } from './openui'

/** A message that starts with Markdown quote lines (a swiped message it answers): the quote, and the words after it. */
export function splitQuoted(text: string) {
  const lines = text.split('\n')
  let end = 0
  while (end < lines.length && lines[end].startsWith('>')) end++
  if (!end) return { quoted: '', words: text }
  return { quoted: lines.slice(0, end).map(line => line.replace(/^>\s?/, '')).join('\n'), words: lines.slice(end).join('\n').trim() }
}

/**
 * A message as words: Markdown marks and citation tokens dropped; for a card
 * (OpenUI), its prose and the quoted words in it. What 复制 copies.
 */
export function plainText(text: string) {
  const split = splitOpenUI(text)
  const words = split
    ? [split.prose, ...[...split.source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1].replace(/\\n/g, '\n').replace(/\\(.)/g, '$1')).filter(part => /[^\x00-\x7f]|\s/.test(part))].filter(Boolean).join('\n')
    : text
  return words.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*|__|`/g, '').trim()
}

/** What a swiped message quotes: its words, shortened to a few lines. */
export const quotable = (text: string) => {
  const words = plainText(text)
  return words.length > 400 ? `${words.slice(0, 400)}…` : words
}
