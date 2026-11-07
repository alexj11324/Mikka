import { afterEach, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { defaultRunPolicy } from '@mikka/protocol/agent-policy'
import { consumeCloudBootstrap } from '../src/cloud-bootstrap'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'claude-hint-')); roots.push(root)
  const config = { deviceId: randomUUID(), workspaceId: randomUUID(), credential: 'orv_' + 'a'.repeat(43), server: 'https://mikka.example' }
  const body = JSON.stringify(config), hash = createHash('sha256').update(body).digest('hex'), runId = randomUUID()
  writeFileSync(join(root, 'bootstrap.json'), body, { mode: 0o600 })
  writeFileSync(join(root, 'initial-run.json'), JSON.stringify({ version: 1, runId, bootstrapSha256: hash }), { mode: 0o600 })
  const hint = { version: 1, runId, bootstrapSha256: hash, profile: 'cloud_repository_claude_v1', model: 'claude-any-explicit-model',
    effort: 'high', github: true, diagnostics: false, kind: 'implement', policy: defaultRunPolicy(), mailboxTools: [],
    decisionCatalogue: { version: 1, tool: { name: 'record_decision', title: 'Record decision', description: 'Fixture',
      inputSchema: { type: 'object', properties: {} }, annotations: { idempotentHint: true } } } }
  const path = join(root, 'anonymous-claude.json')
  const write = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
  return { root, path, hint, write, consume: () => consumeCloudBootstrap(join(root, 'bootstrap.json')) }
}
it('consumes only exact bootstrap/run metadata and leaves the original strict bootstrap intact', () => {
  const f = fixture(); f.write(f.hint)
  const result = f.consume()
  expect(result.initialRunId).toBe(f.hint.runId)
  expect(result.anonymousClaudeHint).toEqual(f.hint)
  expect(existsSync(f.path)).toBe(false)
})
it.each(['missing', 'invalid', 'wrong_hash', 'wrong_run', 'unknown_key', 'oversize'])('falls back for optional %s metadata without altering the locator', kind => {
  const f = fixture()
  if (kind === 'invalid') writeFileSync(f.path, '{', { mode: 0o600 })
  else if (kind !== 'missing') f.write({ ...f.hint,
    ...(kind === 'wrong_hash' ? { bootstrapSha256: '0'.repeat(64) } : {}),
    ...(kind === 'wrong_run' ? { runId: randomUUID() } : {}),
    ...(kind === 'unknown_key' ? { env: { credential: 'never accepted' } } : {}),
    ...(kind === 'oversize' ? { extra: 'x'.repeat(32769) } : {}) })
  const result = f.consume()
  expect(result.initialRunId).toBe(f.hint.runId)
  expect(result.anonymousClaudeHint).toBeUndefined()
})
it.each(['public', 'symlink', 'directory', 'fifo'])('rejects unsafe %s metadata instead of weakening filesystem permission checks', kind => {
  const f = fixture()
  if (kind === 'fifo') execFileSync('mkfifo', ['-m', '600', f.path])
  else if (kind === 'directory') mkdirSync(f.path)
  else if (kind === 'symlink') symlinkSync(join(f.root, 'initial-run.json'), f.path)
  else { f.write(f.hint); chmodSync(f.path, 0o644) }
  expect(f.consume).toThrow()
})
