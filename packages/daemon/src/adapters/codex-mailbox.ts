import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { writeJsonAtomic } from '../fs-util'
import { assertSafeId } from '../ids'
import type { RunMailbox } from '../run-mailbox'

type Catalogue = { type: 'function'; name: string; description: string; inputSchema: Record<string, unknown> }[]
type NativeVersion = '0.163.0' | '0.166.0' | '0.167.0'
type Receipt = { version: 1; nativeVersion: NativeVersion; runId: string; threadId: string; historyPath: string; catalogue: Catalogue }
const unavailable = () => new Error('Run mailbox requires a verified original Codex thread')

/** Verified official releases whose persisted-tool resume semantics were exercised. */
export function codexMailboxResumeVersion(userAgent: unknown): NativeVersion | null {
  // initialize prefixes this with clientInfo.name, not a fixed Codex name.
  const version = typeof userAgent === 'string'
    ? /^[A-Za-z0-9._-]+\/(0\.163\.0|0\.166\.0|0\.167\.0)(?:\s|$)/.exec(userAgent)?.[1]
    : undefined
  return version === '0.163.0' || version === '0.166.0' || version === '0.167.0' ? version : null
}

export function codexMailboxCatalogue(mailbox: RunMailbox): Catalogue {
  // Freeze the exact host catalogue once. Neither rollout metadata nor a
  // resumed CLI may add tools to the current run's callback authority.
  return JSON.parse(JSON.stringify(mailbox.tools.map(tool => ({ type: 'function', ...tool })))) as Catalogue
}

function historyParts(value: unknown): string[] {
  if (typeof value !== 'string' || value.length > 1024 || /[\\\0]/.test(value)) throw unavailable()
  const parts = value.split('/')
  if (!['sessions', 'archived_sessions'].includes(parts[0]) || parts.length < 2 ||
      parts.some(part => !part || part === '.' || part === '..') || !value.endsWith('.jsonl')) throw unavailable()
  return parts
}

function receiptFile(stateDir: string, runId: string): string {
  return join(stateDir, 'codex-mailbox', assertSafeId('run id', runId) + '.json')
}

/** Only fixed, bounded JSON is read; never follow links or log history bytes. */
function readJson(file: string, limit: number, firstLine = false): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.nlink !== 1 || (!firstLine && stat.size > limit)) throw unavailable()
    const buffer = Buffer.alloc(Math.min(stat.size, limit + 1))
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    const end = firstLine ? buffer.subarray(0, length).indexOf(10) : length
    if (end < 0 || end > limit) throw unavailable()
    return JSON.parse(buffer.subarray(0, end).toString('utf8'))
  } finally { closeSync(fd) }
}

function verifyHistory(home: string, path: string, threadId: string, catalogue: Catalogue) {
  const parts = historyParts(path)
  let parent = home
  for (const part of ['', ...parts.slice(0, -1)]) {
    if (part) parent = join(parent, part)
    const stat = lstatSync(parent)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
  }
  const header = readJson(join(home, ...parts), 1024 * 1024, true) as {
    type?: unknown; payload?: { id?: unknown; dynamic_tools?: unknown }
  } | null
  if (header?.type !== 'session_meta' || header.payload?.id !== threadId ||
      !isDeepStrictEqual(header.payload.dynamic_tools, catalogue)) throw unavailable()
}

/**
 * Verified releases resume dynamic tools from the rollout, not resume parameters.
 * The host receipt is a capability record, not a credential or OS boundary;
 * current run checks and the server's mailbox allowlist remain authoritative.
 */
export function verifyCodexMailboxResume(stateDir: string, sourceRunId: string, home: string, threadId: string, catalogue: Catalogue): NativeVersion {
  try {
    const dir = lstatSync(join(stateDir, 'codex-mailbox'))
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw unavailable()
    const receipt = readJson(receiptFile(stateDir, sourceRunId), 256 * 1024) as Partial<Receipt> | null
    if (receipt?.version !== 1 || (receipt.nativeVersion !== '0.163.0' && receipt.nativeVersion !== '0.166.0' && receipt.nativeVersion !== '0.167.0') || receipt.runId !== sourceRunId || receipt.threadId !== threadId ||
        !isDeepStrictEqual(receipt.catalogue, catalogue) || typeof receipt.historyPath !== 'string') throw unavailable()
    verifyHistory(home, receipt.historyPath, threadId, catalogue)
    return receipt.nativeVersion
  } catch { throw unavailable() }
}

/** Record only the actual native response, before this run can send a turn. */
export function recordCodexMailboxSession(stateDir: string, runId: string, home: string, thread: { id: string; path?: string | null }, catalogue: Catalogue, resumed: boolean, nativeVersion: NativeVersion) {
  try {
    if (!thread.id || typeof thread.path !== 'string' || !isAbsolute(thread.path)) throw unavailable()
    const historyPath = relative(home, thread.path).split(sep).join('/')
    historyParts(historyPath)
    // On resume, also check what the CLI actually opened before submitting
    // another prompt. A changed/missing catalogue never becomes a new thread.
    if (resumed) verifyHistory(home, historyPath, thread.id, catalogue)
    const dir = join(stateDir, 'codex-mailbox')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const stat = lstatSync(dir)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable()
    writeJsonAtomic(receiptFile(stateDir, runId), { version: 1, nativeVersion, runId, threadId: thread.id, historyPath, catalogue } satisfies Receipt)
  } catch {
    // A previously supported fresh thread does not become unavailable just
    // because this CLI cannot provide resume evidence. Its later resume still
    // requires the receipt and matching persisted metadata above.
    if (resumed) throw unavailable()
  }
}
