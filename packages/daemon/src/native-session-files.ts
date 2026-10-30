import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The transcript is base64 encoded inside the snapshot and again for JSON
// transport; this cap keeps the request below the server's 2.8 MB bound.
const maxBytes = 1_500_000
const safeId = (id: string) => /^[a-z0-9_-]{1,128}$/i.test(id)
const fail = (): never => { throw new Error('Original hosted session is unavailable') }

/** Only a named transcript is exported, never auth/config files or links. */
export function captureNativeSession(root: string, kind: 'codex' | 'claude_code', sessionId: string): Buffer {
  if (!safeId(sessionId)) return fail()
  const matches: { path: string; relative: string }[] = []
  function walk(path: string, parts: string[]) {
    if (parts.length > 6) return
    const stat = lstatSync(path, {throwIfNoEntry:false})
    if (!stat || stat.isSymbolicLink()) return
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) {
        if (!/^[a-z0-9_.-]{1,200}$/i.test(name) || name === '.' || name === '..') continue
        walk(join(path,name), [...parts,name])
      }
    } else if (stat.isFile() && stat.nlink === 1 && (kind === 'codex' ? parts.at(-1)?.endsWith(`-${sessionId}.jsonl`) : parts.at(-1) === `${sessionId}.jsonl`)) {
      matches.push({path,relative:parts.join('/')})
    }
  }
  walk(root, [])
  if (matches.length !== 1) return fail()
  const canonicalRoot = realpathSync(root)
  const fd = openSync(matches[0].path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd)
    const openedPath = realpathSync(`/proc/self/fd/${fd}`)
    if (!openedPath.startsWith(canonicalRoot + '/') || !stat.isFile() || stat.nlink !== 1 || stat.size < 1 || stat.size > maxBytes) return fail()
    const data = readFileSync(fd)
    if (data.length !== stat.size) return fail()
    return Buffer.from(JSON.stringify({ version:1,kind,sessionId,path:matches[0].relative,data:data.toString('base64') }))
  } finally { closeSync(fd) }
}

/** Restore into a freshly created private tree; never overwrite a file. */
export function restoreNativeSession(root: string, expectedKind: 'codex' | 'claude_code', sessionId: string, snapshot: Buffer): void {
  if (!safeId(sessionId) || snapshot.length > 2_800_000) return fail()
  let item: { version: number; kind: string; sessionId: string; path: string; data: string }
  try { item = JSON.parse(snapshot.toString('utf8')) } catch { return fail() }
  if (!item || item.version !== 1 || item.kind !== expectedKind || item.sessionId !== sessionId || typeof item.path !== 'string' || typeof item.data !== 'string') return fail()
  const parts = item.path.split('/')
  if (!parts.length || parts.length > 6 || parts.some(x => !/^[a-z0-9_.-]{1,200}$/i.test(x) || x === '.' || x === '..')) return fail()
  const filename = parts.at(-1)!
  if (expectedKind === 'codex' ? !filename.endsWith(`-${sessionId}.jsonl`) : filename !== `${sessionId}.jsonl`) return fail()
  const data = Buffer.from(item.data,'base64')
  if (!data.length || data.length > maxBytes || data.toString('base64') !== item.data) return fail()
  mkdirSync(root, {recursive:true,mode:0o700})
  let current = root
  for (const part of parts.slice(0,-1)) {
    current = join(current,part)
    mkdirSync(current,{mode:0o700})
  }
  const target = join(root,...parts)
  if (dirname(target) !== current) return fail()
  writeFileSync(target,data,{flag:'wx',mode:0o600})
}
