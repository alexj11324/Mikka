export const TELEGRAM_MESSAGE_LIMIT = 4096

/** Split by UTF-16 length without breaking Unicode code points. */
export function splitTelegramText(text: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  for (const character of text) {
    if (chunk.length + character.length > TELEGRAM_MESSAGE_LIMIT) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += character
  }
  if (chunk) chunks.push(chunk)
  return chunks
}
