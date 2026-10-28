// A note the person pins on a page in the app-wide browser (top bar 🌐). Notes
// ride at the head of the next message they send, after an artifact quote if
// there is one, so the bot reads them in place and the chat can show them as
// chips above the text:
//   <browser-note n="1" kind="element" url="https://…/memories" label="按钮 · 删除" selector="…">删了，刷新又回来了</browser-note>
// `element` is a part of a same-origin page, found again by its selector.
// `region` is an area dragged over a page the app cannot look inside (another
// origin): only the URL, the box in the frame's viewport and the note are known.

export interface BrowserNoteRect { x: number; y: number; width: number; height: number; viewportWidth: number; viewportHeight: number }

export interface BrowserNote {
  /** 1, 2, 3… in the order the notes were made; shown on the chip. */
  n: number
  kind: 'element' | 'region'
  /** The page the note is on. */
  url: string
  /** For an element: 「按钮 · 删除」. For a region: the page's host and path. */
  label: string
  /** What the person wrote. */
  note: string
  /** For an element: a CSS selector that finds it on that page. */
  selector?: string
  /** For an element: its text, clipped. */
  text?: string
  /** For a region: the dragged box, in CSS pixels of the frame's viewport. */
  rect?: BrowserNoteRect
}

export const NOTE_MAX = 500
export const NOTES_MAX = 20

/** The words on a note's chip: 「1 · 按钮 · 删除 · 删了，刷新又回来了」. */
export function noteChipText(note: Pick<BrowserNote, 'n' | 'label' | 'note'>): string {
  return [String(note.n), note.label, note.note].filter(Boolean).join(' · ')
}

/** What the address bar typed means: an http(s) URL, or null. A bare host gets https; a path stays on `origin`. */
export function normalizeAddress(input: string, origin: string): string | null {
  const value = input.trim()
  if (!value) return null
  let url: URL
  try {
    if (value.startsWith('/')) url = new URL(value, origin)
    else if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value)) url = new URL(value)
    else url = new URL(`https://${value}`)
  } catch { return null }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname || (!url.hostname.includes('.') && url.hostname !== 'localhost' && url.origin !== new URL(origin).origin)) return null
  return url.href
}

/** Whether the page shares the app's origin, so its elements can be picked. */
export function sameOrigin(url: string, origin: string): boolean {
  try { return new URL(url).origin === new URL(origin).origin } catch { return false }
}

/** The page's host and path, as a region note's label. */
export function pageLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${path}`.slice(0, 200)
  } catch { return url.slice(0, 200) }
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/\n/g, ' ')
const escapeBody = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const unescape = (value: string) => value.replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&')

function serialize(note: BrowserNote): string {
  const attributes: [string, string][] = [['n', String(note.n)], ['kind', note.kind], ['url', note.url], ['label', note.label]]
  if (note.selector) attributes.push(['selector', note.selector])
  if (note.text) attributes.push(['text', note.text])
  if (note.rect) {
    const { x, y, width, height, viewportWidth, viewportHeight } = note.rect
    attributes.push(['rect', [x, y, width, height].map(Math.round).join(',')], ['viewport', `${Math.round(viewportWidth)}x${Math.round(viewportHeight)}`])
  }
  return `<browser-note ${attributes.map(([key, value]) => `${key}="${escapeAttribute(value)}"`).join(' ')}>${escapeBody(note.note.slice(0, NOTE_MAX))}</browser-note>`
}

/** The message text with the notes in front, one per line. */
export function withBrowserNotes(text: string, notes: readonly BrowserNote[] | null | undefined): string {
  if (!notes?.length) return text
  return `${notes.map(serialize).join('\n')}\n${text}`
}

const NOTE = /^<browser-note ((?:[a-z]+="[^"]*"\s*)+)>([\s\S]*?)<\/browser-note>\n?/

function parse(attributeText: string, body: string): BrowserNote | null {
  const attributes = Object.fromEntries([...attributeText.matchAll(/([a-z]+)="([^"]*)"/g)].map(([, key, value]) => [key, unescape(value)]))
  const n = Number(attributes.n)
  if (!Number.isInteger(n) || n < 1 || (attributes.kind !== 'element' && attributes.kind !== 'region') || !attributes.url || !attributes.label) return null
  const note: BrowserNote = { n, kind: attributes.kind, url: attributes.url, label: attributes.label, note: unescape(body) }
  if (attributes.selector) note.selector = attributes.selector
  if (attributes.text) note.text = attributes.text
  const box = attributes.rect?.split(',').map(Number)
  const viewport = attributes.viewport?.split('x').map(Number)
  if (box?.length === 4 && viewport?.length === 2 && [...box, ...viewport].every(Number.isFinite)) {
    note.rect = { x: box[0], y: box[1], width: box[2], height: box[3], viewportWidth: viewport[0], viewportHeight: viewport[1] }
  }
  return note
}

/** Splits the notes at the head of a stored message (after any artifact quote) from the rest. */
export function splitBrowserNotes(message: string): { notes: BrowserNote[]; text: string } {
  const notes: BrowserNote[] = []
  let rest = message
  for (let match = NOTE.exec(rest); match; match = NOTE.exec(rest)) {
    const note = parse(match[1], match[2])
    if (!note) break
    notes.push(note)
    rest = rest.slice(match[0].length)
  }
  return notes.length ? { notes, text: rest } : { notes, text: message }
}
