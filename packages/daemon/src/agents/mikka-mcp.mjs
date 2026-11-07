#!/usr/bin/env node
// Mikka's MCP server for agent CLIs: the explicit hand-in tools a real
// harness calls instead of just ending its turn (`submit`, `ask_human`,
// `report_blocked`). It runs inside the agent's sandbox as a stdio child of
// the CLI, with no dependencies, and records the call in the handoff file
// (in the worktree's git dir, writable from the sandbox). The daemon reads
// that file when the turn ends; the file, not the CLI's event stream, is the
// one source of truth for every harness.
//
//   node mikka-mcp.mjs --handoff <file> [--captures <dir> --capture-root <dir>...]
//
// `submit_capture` copies a screenshot or recording the agent made into the
// captures dir; the daemon checks it again and uploads it to the run.
//
// Protocol: MCP over stdio, newline-delimited JSON-RPC 2.0.
import { createHash, randomUUID } from "node:crypto"
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { closeSync, fstatSync, openSync, readSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync, constants } from "node:fs"
import { isAbsolute, join, resolve, sep } from "node:path"
import { request as httpRequest } from 'node:http'

// Acceptance-only, best-effort observation of the two business fetch paths
// below. The receiver is the host's existing loopback OTLP server, not an
// authorization/proxy endpoint. No business call awaits these reports. In
// particular SIGTERM/SIGKILL keep their normal behavior; lost generations and
// missing terminal events must remain unknown in the host's receipt.
function observeMcpHttp(endpoint) {
  const disabled = { begin: () => () => {}, close: () => {} }
  if (typeof endpoint !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}\/v1\/mcp-http\/[a-f0-9]{32}$/.test(endpoint)) return disabled
  try { if (new URL(endpoint).port === '' || Number(new URL(endpoint).port) > 65535) return disabled } catch { return disabled }
  const child = randomUUID().replaceAll('-', '')
  const queue = []
  let sequence = 0, sent = 0, completed = 0, lost = 0, active = false, closed = false
  const loss = () => { lost = Math.min(1_000_000, lost + 1) }
  function pump() {
    if (active || queue.length === 0) return
    active = true
    const body = JSON.stringify({ ...queue.shift(), lost })
    let done = false, timer, request
    const settled = ok => {
      if (done) return
      done = true; clearTimeout(timer)
      if (!ok) loss()
      active = false
      queueMicrotask(pump)
    }
    try {
      request = httpRequest(endpoint, { method: 'POST', agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, response => {
        response.resume()
        response.once('end', () => settled(response.statusCode === 200))
        response.once('error', () => settled(false))
        response.once('aborted', () => settled(false))
      })
      // An observation never keeps an otherwise exiting MCP child alive.
      request.once('socket', socket => socket.unref())
      request.once('error', () => settled(false))
      timer = setTimeout(() => { request.destroy(); settled(false) }, 250)
      timer.unref()
      request.end(body)
    } catch { request?.destroy(); settled(false) }
  }
  function emit(type, fields = {}) {
    const event = { version: 1, child, type, sequence: ++sequence, at: Date.now(), ...fields }
    // Two events per request, start and close. Overflow is a known loss;
    // it cannot turn into a complete zero-request observation.
    if (sequence > 258) { loss(); return }
    queue.push(event); queueMicrotask(pump)
  }
  emit('child_start')
  return {
    begin(operation) {
      if (closed || !['decision_catalogue', 'decision_record'].includes(operation)) { loss(); return () => {} }
      const request = ++sent, started = performance.now()
      emit('request_start', { request, operation })
      let finished = false
      return status => {
        if (finished) return
        finished = true; completed++
        emit('request_end', { request, durationMs: Math.round((performance.now() - started) * 1000) / 1000,
          status: status ?? null, outcome: status >= 200 && status < 300 ? 'ok' : 'error' })
      }
    },
    close() {
      if (closed) return
      closed = true; emit('child_close', { sent, completed })
    },
  }
}
const decisionObserver = observeMcpHttp(process.env.MIKKA_MCP_HTTP_OBSERVATION_URL)
// Decisions travel directly to the bound Mikka worker endpoint. No decision,
// conversation or credential is ever written to the handoff or worktree.
const decisionMcpUrl = process.env.MIKKA_DECISION_MCP_URL
const decisionMcpToken = process.env.MIKKA_DECISION_MCP_TOKEN
const decisionMcpAvailable = Boolean(decisionMcpUrl && /^mkw_[A-Za-z0-9_-]{43}$/.test(decisionMcpToken ?? ''))
let decisionRpcId = 0
async function decisionRpc(operation, method, params) {
  // The audited path contains business requests only. Keep this boundary at
  // the physical send, so another method cannot silently inherit its label.
  if (!(operation === 'decision_catalogue' && method === 'tools/list'
    || operation === 'decision_record' && method === 'tools/call' && params?.name === 'record_decision')) throw new Error('decision_method_invalid')
  if (!decisionMcpAvailable) throw new Error('decision_unavailable')
  const id = ++decisionRpcId
  const observed = decisionObserver.begin(operation)
  let response
  try {
    response = await fetch(decisionMcpUrl, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: { authorization: 'Bearer ' + decisionMcpToken, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    })
    observed(response.status)
  } catch (error) { observed(); throw error }
  if (!response.ok) throw new Error('decision_http_' + response.status)
  const text = await response.text()
  if (text.length > 1_000_000) throw new Error('decision_response_size')
  const envelope = response.headers.get('content-type')?.includes('application/json')
    ? JSON.parse(text)
    : text.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5).trim())).find(value => value.id === id)
  if (!envelope || envelope.id !== id || envelope.error || !envelope.result) throw new Error('decision_response')
  return envelope.result
}
let decisionToolPromise
async function decisionTools() {
  if (!decisionMcpAvailable) return []
  // Use the server's canonical schema rather than a separately maintained copy.
  decisionToolPromise ??= decisionRpc('decision_catalogue', 'tools/list', {}).then(result =>
    Array.isArray(result.tools) ? result.tools.filter(tool => tool.name === 'record_decision' && tool.inputSchema?.type === 'object') : [])
  try { return await decisionToolPromise } catch { decisionToolPromise = undefined; return [] }
}
async function recordDecision(args) {
  try {
    const result = await decisionRpc('decision_record', 'tools/call', { name: 'record_decision', arguments: args })
    if (!Array.isArray(result.content)) throw new Error('decision_response')
    return result
  } catch {
    // Do not relay arbitrary transport text or authorization headers.
    return { isError: true, content: [{ type: 'text', text: 'Decision could not be recorded in Mikka. Check task authority and retry with the same idempotencyKey; do not save it in the repository.' }] }
  }
}

const verifyIndex = process.argv.indexOf('--factory-verify')
const factoryVerify = verifyIndex > 0 ? JSON.parse(process.argv[verifyIndex + 1]) : null
const VERIFY_TOOL = { name: 'verify_command', description: 'Run this Factory check’s frozen command, or the command inferred from repository scripts when the host explicitly enabled inference. Use this tool for real command observations when native shell is unavailable. It does not submit or accept the task.', inputSchema: { type: 'object', properties: { command: { type: 'string' }, basis: { type: 'string' } }, required: ['command'] } }
const artifactIndex = process.argv.indexOf('--factory-artifacts')
const artifactRoot = artifactIndex > 0 ? realpathSync(process.argv[artifactIndex + 1]) : null
// Metadata belongs to the bound worktree, never the CLI's shadow Git context.
const metadataGitEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
const repositoryIndex = process.argv.indexOf('--repository-selection')
const repositoryRoot = repositoryIndex > 0 ? realpathSync(process.argv[repositoryIndex + 1]) : null
const REPOSITORY_TOOL = { name: 'switch_repository', description: 'When this checkout does not match the task, choose the correct owner/repo after inspecting the task, Git origin and repository files. The host rechecks your owner’s live GitHub authorization, preserves this checkout, clones the selected repository into a new bound execution, and continues with the same model and credential. End your turn only if the response confirms a repository selection was recorded. If it reports already_active, continue the task in this checkout. Do not change origin or clone a nested delivery in the wrong worktree. Independent checks cannot switch their fixed candidate.', inputSchema: { type: 'object', properties: { repository: { type: 'string', description: 'Exact GitHub owner/repo or GitHub clone URL.' }, reason: { type: 'string', description: 'Task and repository evidence explaining the mismatch and chosen target.' } }, required: ['repository', 'reason'], additionalProperties: false } }

// This standalone script has no package imports. Match only the standard
// GitHub identity forms accepted by protocol/repository; this is not authority.
function githubRepository(input) {
  if (typeof input !== 'string') return null
  let raw = input.trim()
  if (!raw || raw.length > 4000 || /[\s\\%]/.test(raw) ||
      [...raw].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || /(^|[/:])\.{1,2}(?:\/|$)/.test(raw)) return null
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) raw = `https://github.com/${raw.replace(/\.git$/, '')}.git`
  const scp = /^git@github\.com:([^/].*)$/i.exec(raw)
  if (scp && raw.startsWith('git@')) raw = `ssh://git@github.com/${scp[1]}`
  let url
  try { url = new URL(raw) } catch { return null }
  if (url.hostname.toLowerCase() !== 'github.com' || url.search || url.hash || url.password) return null
  if (!(url.protocol === 'https:' && !url.username && (!url.port || url.port === '443')) &&
      !(url.protocol === 'ssh:' && url.username === 'git' && (!url.port || url.port === '22'))) return null
  const parts = url.pathname.replace(/^\//, '').replace(/\/+$/, '').replace(/\.git$/, '').split('/')
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part) || part === '.' || part === '..' || part.startsWith('-'))) return null
  return parts.join('/').toLowerCase()
}

function selectRepository(args) {
  if (typeof args.repository !== 'string' || !args.repository.trim() || args.repository.length > 4000 || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) throw new Error('repository_selection')
  const git = args => spawnSync('git', ['-C', repositoryRoot, ...args], { env: metadataGitEnv, timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const head = git(['rev-parse', '--verify', 'HEAD'])
  const remote = git(['remote', 'get-url', 'origin'])
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) throw new Error('repository_head')
  const observedRemote = remote.status === 0 ? remote.stdout.trim() : null
  const currentRepository = githubRepository(observedRemote)
  if (currentRepository && currentRepository === githubRepository(args.repository)) {
    return { content: [{ type: 'text', text: JSON.stringify({ status: 'already_active', selectionRecorded: false,
      action: 'continue_current_checkout', currentRepository, observedRemote, observedHead: head.stdout.trim() }) }] }
  }
  record('blocked', { blockedOn: 'repository_selection', summary: args.reason,
    repositorySelection: { repository: args.repository.trim(), reason: args.reason.trim(), observedRemote, observedHead: head.stdout.trim() } }, 'switch_repository')
  return { content: [{ type: 'text', text: 'Repository selection recorded for host authorization and a new checkout. End your turn now. This checkout is preserved; no delivery has been submitted.' }] }
}
const ARTIFACT_TEXT_LIMIT = 64 * 1024
const ARTIFACT_TOOL = { name: 'inspect_artifact', description: 'Read a file in this fixed worktree: byte count, SHA256, Git HEAD, committed file SHA256, Git comparison and complete UTF8 text up to 64 KiB. Optionally compare exact expected UTF8 bytes, including every newline. Binary or larger files return no text. No shell commands, changes, submission or acceptance.', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path relative to this worktree.' }, expectedUtf8: { type: 'string', maxLength: ARTIFACT_TEXT_LIMIT, description: 'Optional exact expected text, including all whitespace and the final newline; at most 64 KiB as UTF8.' } }, required: ['path'], additionalProperties: false } }
const INSPECT_REPOSITORY_TOOL = { name: 'inspect_repository', description: 'Read this fixed worktree’s actual Git HEAD, sanitized GitHub origin, working-tree status and one directory’s files. Supply baseCommit to observe committed changes from that exact baseline to HEAD across the whole worktree. Start with path ".", then inspect a listed directory or read a file with inspect_artifact. Listings, status and comparison are bounded and mark truncation; truncated observations cannot establish the complete change scope. Symlinks and .git are not listed. No shell commands, changes, repository selection, submission or acceptance.', inputSchema: { type: 'object', properties: { path: { type: 'string', maxLength: 2000, description: 'Directory relative to this worktree; defaults to ".".' }, baseCommit: { type: 'string', pattern: '^[a-f0-9]{40}$', description: 'Optional exact baseline commit SHA for committed change scope; full 40-character lowercase hex, never a branch or revision expression.' } }, additionalProperties: false } }

function inspectRepository(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'path' && key !== 'baseCommit')) throw new Error('repository_input')
  if (args.baseCommit !== undefined && (typeof args.baseCommit !== 'string' || !/^[a-f0-9]{40}$/.test(args.baseCommit))) throw new Error('repository_base')
  const path = args.path ?? '.'
  if (typeof path !== 'string' || !path || path.length > 2000 || isAbsolute(path) || /[\\\0]/.test(path) ||
      path.split('/').some(part => part === '..' || part === '.git')) throw new Error('repository_path')
  const directory = resolve(artifactRoot, path)
  if ((directory !== artifactRoot && !directory.startsWith(artifactRoot + sep)) || realpathSync(directory) !== directory) throw new Error('repository_path')
  // Fixed metadata commands only. Ignore the CLI's shadow Git context and
  // repository hooks, fsmonitor and pagers; status must not refresh the index.
  const filterOverrides = []
  const git = argv => execFileSync('git', ['--no-pager', '--no-optional-locks', '-C', artifactRoot,
    '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.pager=cat',
    '-c', 'core.untrackedCache=false', '-c', 'status.submoduleSummary=false', '-c', 'submodule.recurse=false', ...filterOverrides, ...argv],
  { env: { ...metadataGitEnv, GIT_NO_LAZY_FETCH: '1', GIT_NO_REPLACE_OBJECTS: '1' }, timeout: 5000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  // A stat-dirty tracked file makes `git status` run configured clean/process
  // filters. Read names only, never values, then disable each bounded driver.
  let filterKeys = []
  try { filterKeys = git(['config', '--name-only', '--null', '--get-regexp', '^filter\\..*\\.(clean|process|required)$']).toString('utf8').split('\0').filter(Boolean) }
  catch (error) { if (error.status !== 1) throw error }
  if (filterKeys.length > 96 || filterKeys.some(key => !/^filter\.[A-Za-z0-9_.-]{1,200}\.(clean|process|required)$/.test(key))) throw new Error('repository_filters')
  for (const driver of new Set(filterKeys.map(key => key.slice(0, key.lastIndexOf('.'))))) {
    filterOverrides.push('-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`)
  }
  const head = git(['rev-parse', '--verify', 'HEAD']).toString('utf8').trim()
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('repository_head')
  let comparison = null
  if (args.baseCommit !== undefined) {
    const baseCommit = args.baseCommit
    if (git(['cat-file', '-t', baseCommit]).toString('utf8').trim() !== 'commit') throw new Error('repository_base')
    // Compare committed trees, not the clean/dirty working copy or just the
    // last commit. The listed directory never narrows this change scope.
    const parts = new TextDecoder('utf-8', { fatal: true }).decode(git(['diff', '--name-status', '-z',
      '--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none',
      '-O/dev/null', baseCommit, head, '--'])).split('\0')
    if (parts.pop() !== '' || parts.length % 2 !== 0) throw new Error('repository_comparison')
    const changes = []
    let changeBytes = 0
    for (let i = 0; i < parts.length; i += 2) {
      const change = { status: parts[i], path: parts[i + 1] }
      const bytes = Buffer.byteLength(JSON.stringify(change))
      if (changes.length >= 200 || changeBytes + bytes > 16 * 1024) break
      changes.push(change); changeBytes += bytes
    }
    comparison = { baseCommit, head, changes, truncated: changes.length < parts.length / 2 }
  }
  let repository = null
  try {
    let remote = git(['remote', 'get-url', 'origin']).toString('utf8').trim()
    // Never return the raw remote: userinfo, query and fragments may carry
    // credentials. Unsupported/local origins remain unknown, not fabricated.
    if (remote.includes('://')) {
      const url = new URL(remote)
      url.username = ''; url.password = ''; url.search = ''; url.hash = ''
      // Git's SSH user is a transport name, not repository authority.
      if (url.protocol === 'ssh:') url.username = 'git'
      remote = url.toString()
    }
    repository = githubRepository(remote)
  } catch { /* No safe canonical origin is available. */ }
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--ignore-submodules=all'])
  let porcelain = '', statusBytes = 0, statusTruncated = false
  for (const record of status.toString('utf8').split('\0').filter(Boolean)) {
    const bytes = Buffer.byteLength(record + '\0')
    if (statusBytes + bytes > 8192) { statusTruncated = true; break }
    porcelain += record + '\0'; statusBytes += bytes
  }
  const entries = [], directoryEntries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.name !== '.git' && (entry.isFile() || entry.isDirectory()))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  let entryBytes = 0
  for (const entry of directoryEntries) {
    const value = { name: entry.name, kind: entry.isDirectory() ? 'directory' : 'file' }
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (entries.length >= 200 || entryBytes + bytes > 16 * 1024) break
    entries.push(value); entryBytes += bytes
  }
  return { content: [{ type: 'text', text: JSON.stringify({ path, head, repository, comparison,
    origin: repository ? `https://github.com/${repository}.git` : null,
    status: { dirty: status.length > 0, porcelain, truncated: statusTruncated },
    entries, truncated: entries.length < directoryEntries.length }) }] }
}

function inspectArtifact(args) {
  const path = args.path
  let expectedBytes
  if (args.expectedUtf8 !== undefined) {
    if (typeof args.expectedUtf8 !== 'string' || Buffer.byteLength(args.expectedUtf8, 'utf8') > ARTIFACT_TEXT_LIMIT) throw new Error('artifact_expected_text')
    expectedBytes = Buffer.from(args.expectedUtf8, 'utf8')
    if (expectedBytes.toString('utf8') !== args.expectedUtf8) throw new Error('artifact_expected_text')
  }
  if (typeof path !== 'string' || !path || path.length > 2000 || isAbsolute(path) || path.includes('\0') ||
    path.split(/[\\/]/).some(part => part === '..' || part === '.git')) throw new Error('artifact_path')
  const resolved = resolve(artifactRoot, path)
  if (!resolved.startsWith(artifactRoot + sep) || realpathSync(resolved) !== resolved) throw new Error('artifact_path')
  const fd = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let bytes
  const limit = 16 * 1024 * 1024
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > limit) throw new Error('artifact_file')
    bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (bytes.length > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('artifact_changed')
  } finally { closeSync(fd) }
  const git = args => spawnSync('git', ['-C', artifactRoot, ...args], { env: metadataGitEnv, timeout: 5000, maxBuffer: limit + 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  const head = git(['rev-parse', '--verify', 'HEAD'])
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.toString().trim())) throw new Error('artifact_git')
  const committed = git(['show', `HEAD:${path}`])
  const hash = value => createHash('sha256').update(value).digest('hex')
  let contentUtf8 = null, textUnavailable = null
  if (bytes.length > ARTIFACT_TEXT_LIMIT) textUnavailable = 'oversize'
  else {
    try {
      // Fatal decoding never turns invalid bytes into replacement characters;
      // preserve a BOM too, so the text describes the exact file contents.
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) textUnavailable = 'binary'
      else contentUtf8 = text
    } catch { textUnavailable = 'binary' }
  }
  return { content: [{ type: 'text', text: JSON.stringify({ path, bytes: bytes.length, sha256: hash(bytes),
    head: head.stdout.toString().trim(), committedSha256: committed.status === 0 ? hash(committed.stdout) : null,
    contentMatchesGit: committed.status === 0 && bytes.equals(committed.stdout), contentUtf8, textUnavailable,
    ...(expectedBytes === undefined ? {} : { matchesExpectedUtf8: bytes.equals(expectedBytes) }) }) }] }
}

function verifyCommand(args) {
  const command = typeof args.command === 'string' ? args.command.trim() : ''
  if (!command || command.length > 2000 || (factoryVerify.command ? command !== factoryVerify.command.trim() : !factoryVerify.infer || !args.basis?.trim())) throw new Error('Use the frozen command, or provide repository evidence for inference.')
  const home = mkdtempSync(join(tmpdir(), 'mikka-verify-tool-'))
  try {
    const env = { PATH: process.env.PATH, HOME: home, TMPDIR: home, LANG: 'C.UTF-8' }
    for (const name of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','NODE_USE_ENV_PROXY','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR']) if (process.env[name]) env[name] = process.env[name]
    const result = spawnSync(command, { shell: true, cwd: factoryVerify.cwd, env, timeout: 300000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', stdio: ['ignore','pipe','pipe'] })
    return { isError: result.status !== 0, content: [{ type: 'text', text: JSON.stringify({ command, exitCode: result.status, signal: result.signal, stdout: result.stdout?.slice(-8000) ?? '', stderr: result.stderr?.slice(-4000) ?? '', ...(result.error ? { error: 'verification_process_failed' } : {}) }) }] }
  } finally { rmSync(home, { recursive: true, force: true }) }
}
import { createInterface } from "node:readline"
import { copyCaptureFd } from "./capture-copy.mjs"

const handoffIndex = process.argv.indexOf("--handoff")
const handoffFile = handoffIndex > 0 ? process.argv[handoffIndex + 1] : null
if (!handoffFile) {
  process.stderr.write("mikka-mcp: --handoff <file> is required\n")
  process.exit(2)
}
const flagValues = (flag) => process.argv.flatMap((arg, i) => (arg === flag && process.argv[i + 1] ? [process.argv[i + 1]] : []))
const capturesDir = flagValues("--captures")[0] ?? null
const captureRoots = flagValues("--capture-root").flatMap((root) => {
  try { return [realpathSync(root)] } catch { return [] }
})

const stringArray = { type: "array", items: { type: "string" } }

// A `plan` run hands in a spec and the split it proposes instead of code
// (ADR 0047). The shapes are `planSpec` / `planSplit` in
// packages/protocol/src/plan.ts; the daemon checks them again on the way out.
const SPEC_SCHEMA = {
  type: "object",
  description: "The product-level spec. Required on a planning run.",
  properties: {
    title: { type: "string" },
    summary: { type: "string", description: "One paragraph, for the card." },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          heading: { type: "string" },
          items: stringArray,
        },
        required: ["heading", "items"],
      },
    },
  },
  required: ["title", "sections"],
}

const SPLIT_SCHEMA = {
  type: "object",
  description:
    "The issues the spec splits into. Required on a planning run. Every issue needs at least one acceptance criterion; nothing is created until a person approves the split.",
  properties: {
    summary: { type: "string" },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: {
            type: "string",
            description: "Local id; parentKey and blockedBy name these.",
          },
          title: { type: "string" },
          goal: { type: "string" },
          parentKey: { type: "string", description: "Grouping only." },
          blockedBy: {
            ...stringArray,
            description: "Keys that must merge first.",
          },
          criteria: {
            type: "array",
            items: {
              type: "object",
              properties: {
                body: { type: "string" },
                checkCommand: {
                  type: "string",
                  description: "Omit when a person checks it.",
                },
              },
              required: ["body"],
            },
          },
          verifyCommand: { type: "string" },
          predictedFiles: stringArray,
          sizeEstimate: {
            type: "object",
            properties: {
              files: { type: "number" },
              lines: { type: "number" },
            },
            required: ["files", "lines"],
          },
          priority: {
            type: "string",
            enum: ["none", "urgent", "high", "medium", "low"],
          },
        },
        required: ["key", "title", "criteria"],
      },
    },
  },
  required: ["issues"],
}

const TOOLS = [
  {
    name: "submit",
    description:
      "Hand in your finished work. Follow the delivery rules supplied for this run, including any required commit, push, pull request and successful CI checks, before calling this once as your last action. On a planning run, hand in the spec and the split you propose instead of code.",
    inputSchema: {
      type: "object",
      properties: {
        summary: {
          type: "string",
          description: "What you did, in a few sentences.",
        },
        nextStep: {
          type: "string",
          description: "What should happen next, if anything.",
        },
        openQuestions: {
          ...stringArray,
          description: "Questions a human should look at.",
        },
        spec: SPEC_SCHEMA,
        split: SPLIT_SCHEMA,
        previewDatabaseBranch: { type: "string", description: "Name of the preview database branch you actually created or used; omit when none." },
        verificationCommand: { type: "object", description: "For a Factory verification with no frozen command: the command inferred from repository scripts, Makefile or CI and its concrete source. Run it and report its actual observations too. If no command can be inferred, mark that criterion unverified with its reason; do not invent a command or ask the person for one.", properties: { command: { type: "string" }, basis: { type: "string" } }, required: ["command", "basis"] },
        reviewVerdict: { type: "string", enum: ["passed", "changes_requested", "needs_judgment"], description: "The task’s single review: clear defects require changes; ambiguous findings go to the person. An unverified observation is not an observed defect." },
        criteria: {
          type: "array",
          description:
            "One entry per acceptance criterion (AC-n) the issue lists, in order. On a read-only check, an entry with no evidence counts as not passed, so report only what you actually saw.",
          items: {
            type: "object",
            properties: {
              criterionId: {
                type: "string",
                description: "The criterion's id, as given in your brief.",
              },
              text: { type: "string", description: "The criterion checked, required when the brief provides no criterion UUID." },
              passed: { type: "boolean", description: "True only for an observed pass; false for failed and unverified." },
              status: { type: "string", enum: ["passed", "failed", "unverified"] },
              reason: { type: "string", description: "Required for unverified: why the observation could not be made." },
              resolution: { type: "string", description: "For a repair, how the review finding on this criterion was addressed; keep the original criterion id or text." },
              command: { type: "string", description: "Exact command used to check this criterion, when one was run." },
              exitCode: { type: ["integer", "null"], description: "Observed exit code of that command." },
              evidence: {
                type: "string",
                description:
                  "What you saw: the command and its output, or the file and line.",
              },
            },
            required: ["passed"],
          },
        },
      },
      required: ["summary"],
    },
  },
  {
    name: "request_help",
    description:
      "Stop and request missing task context from the Orchestrator. It first checks the issue and existing facts; only genuinely unresolved input is escalated to the person. Work is preserved for the original session.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        context: { type: "string" },
        purpose: { type: "string", enum: ["verification_command"] },
        summary: { type: "string" },
      },
      required: ["question"],
    },
  },
  {
    name: "ask_human",
    description:
      "Stop and ask a human a question you cannot answer yourself (a product decision, missing access). Your work so far is kept; the run continues after the answer.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        kind: { type: "string", enum: ["context", "decision", "permission", "external"] },
        summary: { type: "string", description: "Where you are so far." },
      },
      required: ["question"],
    },
  },
  {
    name: "report_blocked",
    description:
      "Stop because something outside the code blocks you (quota, a service down, a permission you lack).",
    inputSchema: {
      type: "object",
      properties: {
        blockedOn: {
          type: "string",
          description: "The external condition, e.g. quota_exhausted.",
        },
        summary: { type: "string" },
      },
      required: ["blockedOn"],
    },
  },
]

// The same limits as @mikka/protocol/capture; this file has no dependencies.
const CAPTURE_LIMITS = { png: 10_000_000, jpg: 10_000_000, webp: 10_000_000, mp4: 100_000_000, webm: 100_000_000 }
const MAX_QUEUED_CAPTURES = 20
const CAPTURE_TOOL = {
  name: "submit_capture",
  description:
    "Attach a screenshot or screen recording you made (for example with Playwright) to this thread as evidence for the person. PNG, JPEG or WebP up to 10 MB; MP4 or WebM up to 100 MB. Pass a file inside the worktree or your temp directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "The file's path." },
      title: { type: "string", description: "What it shows, for the person." },
    },
    required: ["path", "title"],
  },
}

function sniff(head) {
  const ascii = (at, text) => [...text].every((c, i) => head[at + i] === c.charCodeAt(0))
  if (head.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => head[i] === b)) return "png"
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "jpg"
  if (head.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "webp"
  if (head.length >= 12 && ascii(4, "ftyp")) return "mp4"
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3 && Buffer.from(head).toString("latin1").includes("webm")) return "webm"
  return null
}

/** Copies the file into the captures dir after the checks the daemon repeats. */
function queueCapture(args) {
  if (!capturesDir) throw new Error("Captures are not available in this run.")
  const title = typeof args.title === "string" ? args.title.replace(/\s+/g, " ").trim().slice(0, 200) : ""
  if (!title) throw new Error("A title is required.")
  if (typeof args.path !== "string" || !args.path) throw new Error("A path is required.")
  const real = realpathSync(args.path)
  if (!captureRoots.some((root) => real === root || real.startsWith(root + sep)))
    throw new Error("The file must be inside the worktree or your temp directory.")
  const fd = openSync(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let ext, id
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile()) throw new Error("Not a regular file.")
    const head = Buffer.alloc(64)
    ext = sniff(head.subarray(0, readSync(fd, head, 0, 64, 0)))
    if (!ext) throw new Error("Not a PNG, JPEG or WebP image, or an MP4 or WebM video.")
    if (stat.size === 0 || stat.size > CAPTURE_LIMITS[ext]) throw new Error(`At most ${CAPTURE_LIMITS[ext]} bytes for a .${ext} file.`)
    if (readdirSync(capturesDir).filter((name) => name.endsWith(".json")).length >= MAX_QUEUED_CAPTURES)
      throw new Error("Too many captures waiting to upload; try again shortly.")
    id = randomUUID()
    copyCaptureFd(fd, join(capturesDir, `${id}.${ext}`), stat.size)
  } finally {
    closeSync(fd)
  }
  // The metadata lands last: the daemon only takes files that have one.
  const meta = join(capturesDir, `${id}.json`)
  writeFileSync(`${meta}.tmp`, JSON.stringify({ title, at: new Date().toISOString() }))
  renameSync(`${meta}.tmp`, meta)
}

const KINDS = { submit: "submit", request_help: "ask", ask_human: "ask", report_blocked: "blocked" }

function record(kind, args, toolName) {
  // A planning hand-in carries the spec and the split it proposes. The id is
  // generated here, once, so the cards the daemon puts in the conversation
  // and the row the server stores name the same spec.
  const plan =
    kind === "submit" &&
    typeof args.spec === "object" &&
    args.spec !== null &&
    typeof args.split === "object" &&
    args.split !== null
      ? { specId: randomUUID(), spec: args.spec, split: args.split }
      : null
  const questionText = String(
    kind === "blocked"
      ? (args.blockedOn ?? "External condition")
      : (args.question ?? "Missing task input"),
  )
    .trim()
    .slice(0, 4000)
  const questionKind =
    kind === "blocked"
      ? "external"
      : args.purpose === "verification_command"
        ? "decision"
      : toolName === "request_help"
        ? "context"
        : args.kind === "permission"
          ? "permission"
          : "decision"
  let questionId = randomUUID()
  try {
    const existing = JSON.parse(readFileSync(handoffFile, "utf8"))
    if (
      existing.kind === kind &&
      existing.question?.question === questionText &&
      existing.question.kind === questionKind
    )
      questionId = existing.question.questionId
  } catch {
    /* First durable hand-in; a retry reads the same id above. */
  }
  const handoff = {
    kind,
    ...(kind === "ask" || kind === "blocked"
      ? {
          question: {
            questionId,
            kind: questionKind,
            ...(args.purpose === "verification_command" ? { purpose: args.purpose } : {}),
            question: questionText,
            context: String(args.context ?? args.summary ?? "").slice(0, 4000),
            options: [],
          },
        }
      : {}),
    summary: typeof args.summary === "string" ? args.summary : "",
    nextStep: typeof args.nextStep === "string" ? args.nextStep : null,
    openQuestions: Array.isArray(args.openQuestions)
      ? args.openQuestions.filter((q) => typeof q === "string")
      : typeof args.question === "string"
        ? [args.question]
        : [],
    ...(typeof args.blockedOn === "string"
      ? { blockedOn: args.blockedOn }
      : {}),
    ...(plan ? { plan } : {}),
    // Kept as sent; the daemon validates and trims each entry.
    ...(typeof args.previewDatabaseBranch === "string" ? { previewDatabaseBranch: args.previewDatabaseBranch } : {}),
    ...(Array.isArray(args.criteria) ? { criteria: args.criteria } : {}),
    ...(typeof args.reviewVerdict === "string" ? { reviewVerdict: args.reviewVerdict } : {}),
    ...(args.verificationCommand ? { verificationCommand: args.verificationCommand } : {}),
    ...(args.repositorySelection ? { repositorySelection: args.repositorySelection } : {}),
    at: new Date().toISOString(),
  }
  const tmp = `${handoffFile}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(handoff, null, 2)}\n`)
  renameSync(tmp, handoffFile)
  return plan !== null
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function fail(id, code, message) {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`,
  )
}

async function handle(message) {
  const { id, method, params } = message
  if (id === undefined || id === null) return // notifications
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "mikka", version: "0.0.1" },
      })
    case "ping":
      return reply(id, {})
    case "tools/list":
      return reply(id, { tools: [...TOOLS, ...await decisionTools(), ...(repositoryRoot ? [REPOSITORY_TOOL] : []), ...(capturesDir ? [CAPTURE_TOOL] : []), ...(factoryVerify ? [VERIFY_TOOL] : []), ...(artifactRoot ? [ARTIFACT_TOOL, INSPECT_REPOSITORY_TOOL] : [])] })
    case "tools/call": {
      if (decisionMcpAvailable && params?.name === 'record_decision') return reply(id, await recordDecision(params.arguments ?? {}))
      if (repositoryRoot && params?.name === REPOSITORY_TOOL.name) {
        try { return reply(id, selectRepository(params.arguments ?? {})) }
        catch { return reply(id, { isError: true, content: [{ type: 'text', text: 'Repository selection could not be recorded.' }] }) }
      }
      if (artifactRoot && params?.name === ARTIFACT_TOOL.name) {
        try { return reply(id, inspectArtifact(params.arguments ?? {})) }
        catch { return reply(id, { isError: true, content: [{ type: 'text', text: 'Artifact inspection refused or unavailable.' }] }) }
      }
      if (artifactRoot && params?.name === INSPECT_REPOSITORY_TOOL.name) {
        try { return reply(id, inspectRepository(params.arguments ?? {})) }
        catch { return reply(id, { isError: true, content: [{ type: 'text', text: 'Repository inspection refused or unavailable.' }] }) }
      }
      if (factoryVerify && params?.name === VERIFY_TOOL.name) {
        try { return reply(id, verifyCommand(params.arguments ?? {})) }
        catch { return reply(id, { isError: true, content: [{ type: 'text', text: 'Verification command refused.' }] }) }
      }
      if (capturesDir && params?.name === CAPTURE_TOOL.name) {
        try {
          queueCapture(params.arguments ?? {})
        } catch (error) {
          return reply(id, { isError: true, content: [{ type: "text", text: `Not attached: ${error instanceof Error ? error.message : error}` }] })
        }
        return reply(id, { content: [{ type: "text", text: "Attached to this thread. Keep working; it uploads in the background." }] })
      }
      const kind = KINDS[params?.name]
      if (!kind) return fail(id, -32602, `Unknown tool: ${params?.name}`)
      let planned
      try {
        planned = record(kind, params.arguments ?? {}, params.name)
      } catch (error) {
        return reply(id, {
          isError: true,
          content: [{ type: "text", text: `Could not record: ${error}` }],
        })
      }
      const text =
        kind !== "submit"
          ? "Recorded. End your turn now."
          : planned
            ? "Handed in. End your turn now; a person approves the spec, then the split."
            : "Handed in. End your turn now."
      return reply(id, { content: [{ type: "text", text }] })
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`)
  }
}

let inputClosed = false, activeMessages = 0
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return fail(null, -32700, "Parse error")
  }
  activeMessages++
  void handle(message).catch(() => fail(message.id ?? null, -32603, "Mikka tool unavailable")).finally(() => {
    activeMessages--
    if (inputClosed && activeMessages === 0) decisionObserver.close()
  })
}).once('close', () => {
  inputClosed = true
  if (activeMessages === 0) decisionObserver.close()
})
