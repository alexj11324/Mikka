// Bulk add in 设置 › 密钥与环境: one `KEY=value # note` per line, as a pasted or uploaded .env.
// Pure (no DB, no server-only) so the sheet previews with the same rules the server applies.
import { SECRET_NAME } from './format'

export const DOTENV_MAX_BYTES = 2 * 1024 * 1024

export interface DotenvEntry { line: number; name: string; value: string; note: string }
export type DotenvErrorReason = 'invalidLine' | 'invalidName' | 'emptyValue' | 'duplicate'
export interface DotenvError { line: number; name?: string; reason: DotenvErrorReason }

const NOTE = /^\s*(?:#\s?(.*))?$/

/**
 * Splits a .env text into entries and per-line errors. A note is what follows ` #` after an
 * unquoted value, or `#` after a quoted one; inside quotes `#` is part of the value. A name that
 * repeats keeps its first line and reports the later ones. Throws `dotenvTooLarge` over 2 MB.
 */
export function parseDotenv(text: string): { entries: DotenvEntry[]; errors: DotenvError[] } {
  if (new TextEncoder().encode(text).length > DOTENV_MAX_BYTES) throw new Error('dotenvTooLarge')
  const entries: DotenvEntry[] = [], errors: DotenvError[] = [], seen = new Set<string>()
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const body = trimmed.replace(/^export\s+/, '')
    const eq = body.indexOf('=')
    if (eq <= 0) { errors.push({ line, reason: 'invalidLine' }); return }
    const name = body.slice(0, eq).trim()
    const parsed = valueAndNote(body.slice(eq + 1))
    if (!parsed) { errors.push({ line, name, reason: 'invalidLine' }); return }
    if (!SECRET_NAME.test(name)) { errors.push({ line, name, reason: 'invalidName' }); return }
    if (!parsed.value) { errors.push({ line, name, reason: 'emptyValue' }); return }
    if (seen.has(name)) { errors.push({ line, name, reason: 'duplicate' }); return }
    seen.add(name)
    entries.push({ line, name, ...parsed })
  })
  return { entries, errors }
}

function valueAndNote(rest: string): { value: string; note: string } | null {
  const start = rest.trimStart()
  const quote = start[0]
  if (quote === '"' || quote === "'") {
    const end = start.indexOf(quote, 1)
    if (end < 0) return null
    const after = NOTE.exec(start.slice(end + 1))
    if (!after) return null
    return { value: start.slice(1, end), note: (after[1] ?? '').trim() }
  }
  const hash = start.search(/\s#/)
  return hash < 0 ? { value: start.trim(), note: '' } : { value: start.slice(0, hash).trim(), note: start.slice(hash).replace(/^\s*#\s?/, '').trim() }
}
