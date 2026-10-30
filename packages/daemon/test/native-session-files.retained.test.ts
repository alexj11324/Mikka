import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { captureNativeSession, restoreNativeSession } from '../src/native-session-files'

describe('retained hosted transcript snapshot', () => {
  for (const kind of ['codex','claude_code'] as const) it(`round trips only the named ${kind} transcript`, () => {
    const root = mkdtempSync(join(tmpdir(),'mikka-native-retained-'))
    const source = join(root,'source'), target = join(root,'target')
    mkdirSync(source)
    const session = 'synthetic-session-id'
    const name = kind === 'codex' ? `rollout-2026-01-01-${session}.jsonl` : `${session}.jsonl`
    writeFileSync(join(source,name),'synthetic transcript')
    writeFileSync(join(source,'auth.json'),'synthetic credential')
    const snapshot = captureNativeSession(source,kind,session)
    expect(snapshot.toString()).not.toContain('synthetic credential')
    restoreNativeSession(target,kind,session,snapshot)
    expect(readFileSync(join(target,name),'utf8')).toBe('synthetic transcript')
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
})
