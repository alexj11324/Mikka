import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

// The transcript is base64 encoded inside the snapshot and again for JSON
// transport; this cap keeps the request below the server's 2.8 MB bound.
const maxBytes = 1_500_000
const safeId = (id: string) => /^[a-z0-9_-]{1,128}$/i.test(id)
const fail = (): never => { throw new Error('Original hosted session is unavailable') }

/** Only a named transcript is exported, never auth/config files or links. */
export function captureNativeSession(root: string, kind: 'codex' | 'claude_code', sessionId: string): Buffer {
  const fd=openSync(root,constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { return captureNativeSessionAt(fd,[],kind,sessionId) } finally {closeSync(fd)}
}

/** Anchor traversal to the run directory descriptor captured by the daemon
 * before launching the CLI. Every component is opened without following
 * links; a concurrently replaced parent cannot redirect an opened descriptor. */
export function captureNativeSessionAt(runDirFd:number, rootParts:string[], kind:'codex'|'claude_code', sessionId:string):Buffer {
  if (!safeId(sessionId)) return fail()
  const matches: { data: Buffer; relative: string }[] = []
  let total=0, transcripts=0
  const openChild=(fd:number,name:string,directory:boolean)=>openSync(`/proc/self/fd/${fd}/${name}`,constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0))
  const opened:number[]=[]
  let rootFd=runDirFd
  try {
    for(const part of rootParts){if(!/^[a-z0-9_.-]{1,240}$/i.test(part)||part==='.'||part==='..')return fail();rootFd=openChild(rootFd,part,true);opened.push(rootFd)}
  function walk(fd:number, parts: string[], sidecar=false) {
    if (parts.length > 6) return
      for (const name of readdirSync(`/proc/self/fd/${fd}`)) {
        if (!/^[a-z0-9_.-]{1,200}$/i.test(name) || name === '.' || name === '..') continue
        const relative=[...parts,name]
        const isTranscript=!sidecar && (kind === 'codex' ? name.endsWith(`-${sessionId}.jsonl`) : name === `${sessionId}.jsonl`)
        const isMatch=isTranscript || sidecar
        let child:number
        if(sidecar) {
          try {child=openChild(fd,name,true);try{walk(child,relative,true)}finally{closeSync(child)};continue} catch { /* a file is checked below */ }
        }
        try {child=openChild(fd,name,!isMatch)} catch {if(sidecar)return fail();continue}
        try {
          const stat=fstatSync(child)
          if(isMatch) {
            if(!stat.isFile()||stat.nlink!==1||stat.size<(isTranscript?1:0)||stat.size>maxBytes)return fail()
            const data=readFileSync(child);if(data.length!==stat.size)return fail()
            total+=data.length;if(total>maxBytes||matches.length>=256)return fail()
            if(isTranscript)transcripts++
            matches.push({relative:relative.join('/'),data})
          } else if(stat.isDirectory() && (kind==='codex'||name===sessionId)) walk(child,relative,kind==='claude_code')
        } finally {closeSync(child)}
      }
  }
  walk(rootFd, [])
  if (transcripts !== 1) return fail()
  return Buffer.from(JSON.stringify({version:2,kind,sessionId,files:matches.map(file=>({path:file.relative,data:file.data.toString('base64')}))}))
  } finally {for(const fd of opened.reverse())closeSync(fd)}
}

/** Restore into a freshly created private tree; never overwrite a file. */
export function restoreNativeSession(root: string, expectedKind: 'codex' | 'claude_code', sessionId: string, snapshot: Buffer): void {
  if (!safeId(sessionId) || snapshot.length > 2_800_000) return fail()
  let item: { version: number; kind: string; sessionId: string; files: Array<{path:string;data:string}> }
  try { item = JSON.parse(snapshot.toString('utf8')) } catch { return fail() }
  if (!item || item.version !== 2 || item.kind !== expectedKind || item.sessionId !== sessionId || !Array.isArray(item.files) || !item.files.length || item.files.length>256) return fail()
  const prepared:Array<{parts:string[];data:Buffer}>=[];let total=0,transcripts=0
  for(const file of item.files) {
  if(!file||typeof file.path!=='string'||typeof file.data!=='string')return fail()
  const parts = file.path.split('/')
  if (!parts.length || parts.length > 6 || parts.some(x => !/^[a-z0-9_.-]{1,200}$/i.test(x) || x === '.' || x === '..')) return fail()
  const filename = parts.at(-1)!
  const transcript=expectedKind==='codex'?filename.endsWith(`-${sessionId}.jsonl`):parts.length===1 && filename===`${sessionId}.jsonl`
  if(!transcript && !(expectedKind==='claude_code' && parts.length>1 && parts[0]===sessionId))return fail()
  if(transcript)transcripts++
  const data = Buffer.from(file.data,'base64'); total+=data.length
  if ((transcript && !data.length) || total > maxBytes || data.toString('base64') !== file.data || prepared.some(x=>x.parts.join('/')===file.path)) return fail()
  prepared.push({parts,data})
  }
  if(transcripts!==1)return fail()
  mkdirSync(root, {mode:0o700})
  for(const {parts,data} of prepared){
  let current = root
  for (const part of parts.slice(0,-1)) {
    current = join(current,part)
    try {mkdirSync(current,{mode:0o700})} catch {const stat=lstatSync(current,{throwIfNoEntry:false});if(!stat?.isDirectory()||stat.isSymbolicLink())return fail()}
  }
  const target = join(root,...parts)
  if (dirname(target) !== current) return fail()
  writeFileSync(target,data,{flag:'wx',mode:0o600})
  }
}
