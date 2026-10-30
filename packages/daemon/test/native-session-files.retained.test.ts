import { describe, expect, it } from 'vitest'
import { constants, closeSync, mkdtempSync, mkdirSync, openSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureNativeSession, captureNativeSessionAt, restoreNativeSession } from '../src/native-session-files'

describe('retained hosted transcript snapshot', () => {
  for (const kind of ['codex','claude_code'] as const) it(`round trips only the named ${kind} transcript`, () => {
    const root = mkdtempSync(join(tmpdir(),'mikka-native-retained-'))
    const source = join(root,'source'), target = join(root,'target')
    mkdirSync(source)
    const session = 'synthetic-session-id'
    const name = kind === 'codex' ? `rollout-2026-01-01-${session}.jsonl` : `${session}.jsonl`
    writeFileSync(join(source,name),'synthetic transcript')
    if(kind==='claude_code'){mkdirSync(join(source,session));writeFileSync(join(source,session,'subagent.jsonl'),'synthetic subagent history')}
    writeFileSync(join(source,'auth.json'),'synthetic credential')
    const snapshot = captureNativeSession(source,kind,session)
    expect(snapshot.toString()).not.toContain('synthetic credential')
    restoreNativeSession(target,kind,session,snapshot)
    expect(readFileSync(join(target,name),'utf8')).toBe('synthetic transcript')
    if(kind==='claude_code')expect(readFileSync(join(target,session,'subagent.jsonl'),'utf8')).toBe('synthetic subagent history')
    expect(() => restoreNativeSession(target,kind,session,snapshot)).toThrow()
    expect(() => restoreNativeSession(join(root,'other'),kind,'wrong',snapshot)).toThrow()
  })
  it('refuses a symlinked transcript', () => {
    const root = mkdtempSync(join(tmpdir(),'mikka-native-retained-'))
    writeFileSync(join(root,'outside'),'synthetic')
    mkdirSync(join(root,'source'))
    symlinkSync(join(root,'outside'),join(root,'source','id.jsonl'))
    expect(() => captureNativeSession(join(root,'source'),'claude_code','id')).toThrow()
  })
  it('anchors capture to the original directory even if its path is replaced',()=>{
    const root=mkdtempSync(join(tmpdir(),'mikka-native-anchor-retained-'))
    const original=join(root,'original'),moved=join(root,'moved'),outside=join(root,'outside')
    mkdirSync(original);mkdirSync(outside);mkdirSync(join(original,'sessions'));mkdirSync(join(outside,'sessions'))
    writeFileSync(join(original,'sessions','rollout-id.jsonl'),'original')
    writeFileSync(join(outside,'sessions','rollout-id.jsonl'),'outside')
    const fd=openSync(original,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW)
    try {
      renameSync(original,moved);symlinkSync(outside,original)
      const snapshot=captureNativeSessionAt(fd,['sessions'],'codex','id')
      const target=join(root,'restored');restoreNativeSession(target,'codex','id',snapshot)
      expect(readFileSync(join(target,'rollout-id.jsonl'),'utf8')).toBe('original')
    } finally {closeSync(fd)}
  })
  it('retains a large complete transcript and rejects a larger one without truncation', () => {
    const root=mkdtempSync(join(tmpdir(),'mikka-native-size-retained-'))
    const source=join(root,'source'),target=join(root,'target');mkdirSync(source)
    const file=join(source,'id.jsonl'),content=Buffer.alloc(1_500_000,0x61)
    writeFileSync(file,content)
    const snapshot=captureNativeSession(source,'claude_code','id')
    restoreNativeSession(target,'claude_code','id',snapshot)
    expect(readFileSync(join(target,'id.jsonl')).equals(content)).toBe(true)
    writeFileSync(join(source,'large-id.jsonl'),Buffer.alloc(1_500_001,0x62))
    expect(()=>captureNativeSession(source,'codex','id')).toThrow()
  })
})
