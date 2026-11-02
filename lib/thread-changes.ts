/**
 * A thread's 改动 tab (Figma 820:4843): the agent's work tree diff, read-only.
 * The run's checkpoint holds it as a gzipped `git diff --binary` (lib/db/schema.ts
 * `runCheckpoints`); this turns its text into files the tab draws in order.
 */

export type DiffLineKind = 'context' | 'added' | 'removed'

export interface DiffLine { kind: DiffLineKind; old: number | null; new: number | null; text: string }

/** A line, or a run of lines the diff left out between hunks, drawn as one 「N 行未修改」 row. */
export type DiffBlock = { kind: 'line'; line: DiffLine } | { kind: 'unchanged'; count: number }

export interface ChangedFile {
  path: string
  /** The old path of a renamed file. */
  previousPath: string | null
  status: 'added' | 'deleted' | 'renamed' | 'modified'
  binary: boolean
  additions: number
  deletions: number
  blocks: DiffBlock[]
  /** The file in the thread's pull request on GitHub, when it has one. */
  url?: string
}

export interface ThreadChanges { files: ChangedFile[]; additions: number; deletions: number }

export type ThreadChangesResult = { state: 'none' } | { state: 'tooLarge' } | { state: 'ready'; changes: ThreadChanges }

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
const GIT_HEADER = /^diff --git ("[^"]*"|\S+) ("[^"]*"|\S+)$/

function unquote(path: string) {
  if (!path.startsWith('"')) return path
  try { return JSON.parse(path) as string } catch { return path.slice(1, -1) }
}

function stripPrefix(path: string) {
  const clean = unquote(path.trim())
  return clean === '/dev/null' ? null : clean.replace(/^[ab]\//, '')
}

/** Parses `git diff` output into files, in the diff's order, with 「N 行未修改」 gaps between hunks. */
export function parseUnifiedDiff(text: string): ThreadChanges {
  const files: ChangedFile[] = []
  let file: ChangedFile | null = null
  // The hunk being read: lines left on each side, and where the next line of each side is.
  let oldLeft = 0, newLeft = 0, oldLine = 0, newLine = 0, oldEnd = 1
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (file && (oldLeft > 0 || newLeft > 0)) {
      const mark = line[0]
      if (mark === '\\') continue
      if (mark === '+') { file.blocks.push({ kind: 'line', line: { kind: 'added', old: null, new: newLine++, text: line.slice(1) } }); file.additions++; newLeft--; continue }
      if (mark === '-') { file.blocks.push({ kind: 'line', line: { kind: 'removed', old: oldLine++, new: null, text: line.slice(1) } }); file.deletions++; oldLeft--; oldEnd = oldLine; continue }
      if (mark === ' ' || line === '') { file.blocks.push({ kind: 'line', line: { kind: 'context', old: oldLine++, new: newLine++, text: line.slice(1) } }); oldLeft--; newLeft--; oldEnd = oldLine; continue }
      oldLeft = newLeft = 0
    }
    if (line.startsWith('diff --git ')) {
      const match = GIT_HEADER.exec(line)
      file = { path: (match && stripPrefix(match[2])) ?? '', previousPath: null, status: 'modified', binary: false, additions: 0, deletions: 0, blocks: [] }
      files.push(file); oldEnd = 1
      continue
    }
    if (!file) continue
    const hunk = HUNK.exec(line)
    if (hunk) {
      const oldStart = Number(hunk[1]), newStart = Number(hunk[3])
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4])
      // An empty old side (`-0,0`, `-12,0`) starts after its line, not on it.
      const first = oldLeft === 0 ? oldStart + 1 : oldStart
      if (first - oldEnd > 0 && file.status !== 'added') file.blocks.push({ kind: 'unchanged', count: first - oldEnd })
      oldLine = oldStart === 0 ? 1 : oldStart; newLine = newStart === 0 ? 1 : newStart
      oldEnd = first
      continue
    }
    if (line.startsWith('new file mode')) file.status = 'added'
    else if (line.startsWith('deleted file mode')) file.status = 'deleted'
    else if (line.startsWith('rename from ')) { file.previousPath = unquote(line.slice(12)); file.status = 'renamed' }
    else if (line.startsWith('rename to ')) file.path = unquote(line.slice(10))
    else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
    else if (line.startsWith('+++ ')) { const path = stripPrefix(line.slice(4)); if (path) file.path = path }
  }
  return { files, additions: files.reduce((sum, item) => sum + item.additions, 0), deletions: files.reduce((sum, item) => sum + item.deletions, 0) }
}

/** The file name and its folder, as the header and the file list show them. */
export function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf('/')
  return at < 0 ? { name: path, dir: '' } : { name: path.slice(at + 1), dir: path.slice(0, at + 1) }
}

export type DiffWrap = 'wrap' | 'scroll'

/** The person's choice for long lines, kept on this device. */
export const DIFF_WRAP_KEY = 'mikka:diff-wrap'

/** Long lines wrap unless the person chose horizontal scrolling. */
export function diffWrapFrom(stored: string | null | undefined): DiffWrap {
  return stored === 'scroll' ? 'scroll' : 'wrap'
}
