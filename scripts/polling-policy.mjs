// No new periodic data polling (docs/design/decisions/2026-11-05-0200-no-new-polling.md).
// Data changes reach the screen by live push (hooks/use-live-key.tsx, lib/live/*),
// tracked in #1212. Every poller that exists today is listed in pollingAllowlist,
// with its reason and its hit count, so the list only shrinks: a new poller fails,
// a replaced one must leave the list.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import ts from 'typescript'

export const pollingMessage = '不要新增轮询；数据变化用 live push（`hooks/use-live-key.tsx` / `lib/live/*`），见 #1212；确实只是界面计时器或外部 API 才加入 allowlist 并写明原因。'

export const pollingRoots = ['app/', 'components/', 'hooks/', 'lib/', 'packages/daemon/src/', 'apps/mobile/', 'apps/desktop/src/', 'workflows/']

const web = 'hooks/use-live-key.tsx'
const daemon = 'lib/device-gateway-notify.ts'
const server = 'lib/live/notify.ts'
const db = (replaceWith, reason, hits) => ({ tracking: '#1212', replaceWith, reason, hits })
const ui = (reason, hits) => ({ kind: 'ui-timer', reason, hits })
const external = (reason, hits) => ({ kind: 'external', reason, hits })
const local = (reason, hits) => ({ kind: 'local', reason, hits })

/**
 * Files allowed to poll, and why. `hits` is the number of findings the file has
 * today; more fails (new polling), fewer fails too (lower it, or drop the entry).
 * - kind 'ui-timer': reads no data (animations, clocks, loaders).
 * - kind 'external': polls a third-party API, not our database.
 * - kind 'local': waits on state on the same machine (a file lock, a local browser), no network.
 * - kind 'keepalive': keeps the live push connection itself open.
 * - tracking '#1212': a database poll still waiting to be replaced by push, through `replaceWith`.
 */
export const pollingAllowlist = {
  'lib/builtin-gateway/scheduler.ts': local('自托管 cron 调度器替代 Cloudflare cron，不是数据轮询；复用已有 due-timer 和 15 分钟 safety sweep', 1),
  // Web: SWR polling that reads our database.
  'components/workspace/issue-pull-request-link.tsx': db(web, 'a PR with no webhook of ours (linked by hand, or a repository without the app) is re-checked with GitHub every 5 min while visible; a run-delivered PR also re-reads on pull_request_status', 1),
  // Server: loops that re-query our database.
  'app/v1/devices/[deviceId]/commands/route.ts': db(daemon, 'long poll fallback timer only: with the gateway configured it waits on LISTEN for the device (re-check per NOTIFY, one final check at the deadline); every 5 s without push or if LISTEN drops', 1),
  'lib/coordinator/group-turns.ts': db(server, 'untilStopped fallback only: 15 s for best-effort subscriptions or a failed reliable-push read, 1 s if LISTEN is unavailable', 1),
  'workflows/run-publication/workflow.ts': db(server, 'untilDone: publish and fail results retried with exponential backoff, 30 s doubling to a 10 min cap, until done (GitHub outage or another worker\'s lease; nothing to push)', 1),
  // Daemon: loops that call our server, which reads the database.
  'packages/daemon/src/agents/tool-approval.ts': db(daemon, 'ToolApprovalGate fallback timer only: none while the device gateway pushes run control, every 20 s while it is down (always so for a cloud computer, whose server pushes), 1 s against a server older than run-control push; a watcher with timedFloorMs runs at most that often on timer ticks', 1),
  'packages/daemon/src/computer/web-review.ts': db(daemon, 'pollWebComputerReviews: checks the local broker every second; with review push it syncs only when the pending set changes, on a gateway push, or every 5 s for presence (the server takes decisions on requests seen in the last 10 s); every second only against a server without review push or while the gateway is down', 1),
  'packages/daemon/src/login.ts': db(daemon, 'device login polls the token endpoint at the server-given interval until approved (RFC 8628)', 1),
  'packages/daemon/src/runs/supervisor.ts': db(daemon, 'CHECKPOINT_EVERY_MS: a periodic write, not a read; saves an idle run\'s checkpoint to the server at most every 2 min', 1),
  // Third-party APIs.
  'packages/daemon/src/quota/poller.ts': external('provider quota (Claude/Codex), every 3 min; not our database', 2),
  'apps/desktop/src/main/index.ts': external('the existing published GitHub desktop-release update check; no Mikka database request and disabled in Mikka Dev', 1),
  'apps/desktop/src/main/ssh-install.ts': external('bounded SSH installation handshake (30 attempts) reads remote daemon status after an explicit user install; not idle application polling', 1),
  // Same machine only.
  'packages/daemon/src/lock.ts': local('waits for the daemon file lock', 1),
  'packages/daemon/src/repositories.ts': local('waits for the repository cache file lock', 1),
  'packages/daemon/src/adapters/mock.ts': local('mock adapter paces scripted output', 1),
  'lib/db/transport-sample.ts': local('flushes the in-process database transfer counter to the log once a minute; runs no query', 1),
  'lib/schedules/claim-child.mts': local('keeps a database-test child process alive until it is killed; reads nothing', 1),
  // The push channel's own keepalive.
  'packages/daemon/src/device-gateway.ts': { kind: 'keepalive', reason: 'pings the device gateway WebSocket so live push stays connected; reads no data', hits: 1 },
  // UI timers: read no data.
  'components/motion/loader.tsx': ui('loader animation frames', 3),
  'components/ui/thinking-loader-clean.tsx': ui('thinking loader animation', 1),
  'components/workspace/agent-demo.tsx': ui('types out the demo code', 1),
  'components/onboarding/onboarding.tsx': ui('onboarding waits up to 5 s for data another hook is already loading; no read of its own', 2),
  'apps/mobile/components/beui/components/loader/loader.tsx': ui('loader animation frames', 3),
  'apps/mobile/components/beui/components/loading-states/agent-progress.tsx': ui('progress animation', 1),
  'apps/mobile/components/beui/components/loading-states/reasoning-text.tsx': ui('reasoning text animation', 2),
  'apps/mobile/components/beui/components/tool-result/tool-result.tsx': ui('elapsed-time clock', 1),
  'hooks/settings/use-subscriptions.ts': ui('the 30 s setInterval only ages the meters\' "updated" label; the meters themselves read on the model_settings push and on focus once older than 5 min', 1),
  'apps/mobile/features/chat/screens/chat-screen.tsx': ui('the 1 s elapsed clock of a reply in progress; the chat and its proposals are pushed (lib/live.ts)', 1),
  'components/version-guard.tsx': ui('checks the public build metadata once a minute (decision 2026-11-03-1437); no database read', 1),
}

const delayCall = /\bawait\s+(?:(?:sleep|delay|wait|pause|setTimeout|scheduler\.wait)\s*\(|new\s+Promise\b[\s\S]{0,300}?\bsetTimeout\b)/
// The interval may be the literal 0 or false; anything else (a number, a constant, a function) polls.
const off = String.raw`\s*(?:0|false)\s*(?:[,}\n)]|$)`

const definition = /^\s*(?:export\s+)?(?:async\s+)?function\s*$/
const rules = [
  { rule: 'polling/refresh-interval', pattern: new RegExp(String.raw`\b(?:refreshInterval|refetchInterval)\s*:(?!${off})`, 'g') },
  { rule: 'polling/refresh-interval', pattern: new RegExp(String.raw`\b(?:refreshInterval|refetchInterval)\s*=\s*\{(?!\s*(?:0|false)\s*\})`, 'g') },
  { rule: 'polling/refresh-interval', pattern: /[{,]\s*(?:refreshInterval|refetchInterval)\s*(?=[,}])/g },
  { rule: 'polling/set-interval', pattern: /\bsetInterval\s*\(/g },
  { rule: 'polling/poll-constant', pattern: /\b[A-Z][A-Z0-9_]*(?:_POLL_MS|POLL_INTERVAL[A-Z0-9_]*|_EVERY_MS)\s*=(?!=)/g },
  // The daemon's gate.watch is push-driven; its fallback timer counts in tool-approval.ts.
  { rule: 'polling/helper', skip: definition, pattern: /\bpollUntil\(/g },
]

// Mobile useApi's second argument is a reader, not the retired interval.
// Parse calls so commas in the path expression and reader callbacks cannot be
// mistaken for an interval. Typechecking the application still requires a reader.
function useApiIntervals(file, source) {
  if (!/\buseApi\b/.test(source)) return []
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
  const options = { noLib: true, noResolve: true, allowJs: true }
  const checker = ts.createProgram([file], options, {
    ...ts.createCompilerHost(options), getSourceFile: name => name === file ? ast : undefined,
  }).getTypeChecker()
  const found = []
  const interval = type => type.isUnion() ? type.types.some(interval)
    : Boolean(type.flags & ts.TypeFlags.NumberLike) && !(type.isNumberLiteral() && type.value === 0)
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'useApi'
        && node.arguments[1] && interval(checker.getTypeAtLocation(node.arguments[1]))) found.push(node.getStart(ast))
    ts.forEachChild(node, visit)
  }
  visit(ast)
  return found
}

/** Where a loop body ends: a braced block, or the rest of its single-statement line. */
function loopBody(source, from) {
  const lead = source.slice(from).match(/^\s*/)[0].length
  const start = from + lead
  const lineEnd = source.indexOf('\n', start)
  if (source[start] !== '{') return source.slice(start, lineEnd < 0 ? source.length : lineEnd)
  for (let depth = 0, i = start; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1)
  }
  return source.slice(start)
}

/**
 * A `while` or `for` loop that awaits a delay: sleep, delay, wait, pause, setTimeout.
 * Skipped: `for…of`/`for…in`, and short retries bounded by a literal of 10 or less
 * (`attempt < 3`), which back off rather than poll.
 */
function sleepLoops(source) {
  const found = []
  for (const match of source.matchAll(/\b(?:while|for)\s*\(/g)) {
    let i = match.index + match[0].length
    for (let depth = 1; depth > 0 && i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') depth--
    }
    const header = source.slice(match.index, i)
    if (/^for\s*\(\s*(?:const|let|var)\s+[^;]*?\b(?:of|in)\b/.test(header)) continue
    if (/<=?\s*(?:10|[0-9])\s*[;)&|]/.test(header)) continue
    if (delayCall.test(loopBody(source, i))) found.push(match.index)
  }
  return found
}

function at(file, source, index, rule) {
  const before = source.slice(0, index)
  return { file, line: before.split('\n').length, column: index - before.lastIndexOf('\n'), rule, message: pollingMessage }
}

/** Every polling site in one file, allowlisted or not. */
export function findPolling(file, source) {
  const found = []
  for (const { rule, pattern, skip } of rules) {
    for (const match of source.matchAll(pattern)) {
      if (skip && skip.test(source.slice(source.lastIndexOf('\n', match.index) + 1, match.index))) continue
      found.push(at(file, source, match.index, rule))
    }
  }
  for (const index of sleepLoops(source)) found.push(at(file, source, index, 'polling/sleep-loop'))
  for (const index of useApiIntervals(file, source)) found.push(at(file, source, index, 'polling/helper'))
  return found.sort((a, b) => a.line - b.line || a.column - b.column)
}

/** Findings that fail: polling in a file not on the allowlist, or more than its entry allows. */
export function auditPolling(file, source, allowlist = pollingAllowlist) {
  const found = findPolling(file, source)
  const entry = allowlist[file]
  if (!entry) return found
  if (found.length > entry.hits) return found.map(d => ({ ...d, message: `${pollingMessage}（allowlist 只允许这个文件 ${entry.hits} 处，现在 ${found.length} 处）` }))
  return []
}

export function pollingPolicyFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(file => pollingRoots.some(root => file.startsWith(root))
      && /\.(?:[cm]?[jt]sx?)$/.test(file)
      && !/(?:^|\/)(?:node_modules|\.next|dist|out|build|__tests__|tests?|e2e)\//.test(file)
      && !/\.(?:test|spec|fixture|stories)\.[cm]?[jt]sx?$/.test(file)
      && !file.endsWith('.d.ts')
      && existsSync(file))
}

/** Tests are not shipped code: test files by name, and files that import a test runner. */
export const isTestSource = source => /\bfrom\s+['"](?:node:test|vitest|bun:test|@playwright\/test)['"]/.test(source)

export function auditRepository() {
  return pollingPolicyFiles().flatMap(file => {
    const source = readFileSync(file, 'utf8')
    return isTestSource(source) ? [] : auditPolling(file, source)
  })
}

/** Allowlist entries that no longer match the code: a replaced poller, or a count to lower. */
export function staleAllowlistEntries(allowlist = pollingAllowlist) {
  return Object.entries(allowlist).flatMap(([file, entry]) => {
    if (!existsSync(file)) return [`${file}: file no longer exists; delete its pollingAllowlist entry`]
    const hits = findPolling(file, readFileSync(file, 'utf8')).length
    if (hits === 0) return [`${file}: no polling left; delete its pollingAllowlist entry`]
    if (hits < entry.hits) return [`${file}: ${hits} polling sites, allowlist says ${entry.hits}; lower it`]
    return []
  })
}
