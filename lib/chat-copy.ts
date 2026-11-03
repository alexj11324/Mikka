import { openUIText, parseOpenUI, splitOpenUI } from './openui-lang'

/**
 * What 复制 on a reply copies: its Markdown as written. A card (OpenUI) has no Markdown of its own, so its prose and
 * the words in the card are copied instead of the program that draws it.
 */
export function replyCopyText(text: string): string {
  const split = splitOpenUI(text)
  if (!split) return text.trim()
  const card = parseOpenUI(split.source)
  return [split.prose, card === null ? '' : openUIText(card)].filter(Boolean).join('\n\n').trim()
}
