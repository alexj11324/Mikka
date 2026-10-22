export type TelegramCommand = { name: string; args: string }

export function parseTelegramCommand(text: string, botUsername: string): TelegramCommand | null {
  const match = text.trim().match(/^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:[ \t]+([\s\S]*))?$/i)
  if (!match || (match[2] && match[2].toLowerCase() !== botUsername.replace(/^@/, '').toLowerCase())) return null
  return { name: match[1].toLowerCase(), args: match[3]?.trim() ?? '' }
}
