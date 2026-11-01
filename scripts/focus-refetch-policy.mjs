// No data is read again because a window, page or app comes back into focus or
// view (docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md). Data
// loads on mount, after the person's own changes, from pushes and on explicit
// polling. Listeners that only pause animation or flush state are allowed by
// file, each with its reason.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** Files allowed to listen for focus, visibility or app state, and why. */
export const focusListenerAllowlist = {
  'components/agents/voice-orb/renderer.ts': 'pauses and resumes the orb animation; reads no data',
  'components/nav/bot-avatar.tsx': 'resyncs avatar animation clocks; reads no data',
  'lib/hooks/use-unread-indicators.ts': 'flushes read receipts when the page hides; nothing runs on show',
  'lib/hooks/use-check-on-return.ts': 'one check, armed only by a hand-off to the browser or Telegram, never by plain focus',
  'apps/mobile/lib/push.ts': 'refreshes the push token registration; the screen is not re-read',
  'apps/mobile/lib/updates.ts': 'prefetches an OTA bundle in the background; the screen is not re-read',
  'apps/mobile/lib/useApi.ts': 'pauses explicit polling in the background and resumes its schedule; no read on return',
}

const rules = [
  { rule: 'focus/swr-revalidate-on-focus', pattern: /\brevalidateOnFocus\s*:(?!\s*false\b)/g, message: 'revalidateOnFocus 只能是 false：聚焦不重查数据。' },
  { rule: 'focus/refetch-on-window-focus', pattern: /\brefetchOnWindowFocus\s*:(?!\s*false\b)/g, message: 'refetchOnWindowFocus 只能是 false：聚焦不重查数据。' },
  { rule: 'focus/focus-manager', pattern: /\bfocusManager\b/g, message: '不用 focusManager 在聚焦时重查。' },
  { rule: 'focus/listener', listener: true, pattern: /\baddEventListener\(\s*['"](?:focus|visibilitychange|pageshow)['"]/g, message: '聚焦、可见或回到页面时不重查数据；真需要监听（动画等）就加入 focusListenerAllowlist 并写明原因。' },
  { rule: 'focus/listener', listener: true, pattern: /\bAppState\.addEventListener\(\s*['"]change['"]/g, message: '回到前台时不重查数据；真需要监听就加入 focusListenerAllowlist 并写明原因。' },
]

export function auditFocusRefetch(file, source) {
  const diagnostics = []
  for (const { rule, pattern, message, listener } of rules) {
    if (listener && Object.hasOwn(focusListenerAllowlist, file)) continue
    for (const match of source.matchAll(pattern)) {
      const before = source.slice(0, match.index)
      const line = before.split('\n').length
      diagnostics.push({ file, line, column: match.index - before.lastIndexOf('\n'), rule, message })
    }
  }
  return diagnostics
}

export function focusPolicyFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(file => /\.(?:[cm]?[jt]sx?)$/.test(file) && !/(?:^|\/)(?:node_modules|\.next|dist|out|build)\//.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts') && file !== 'scripts/focus-refetch-policy.mjs' && existsSync(file))
}

export function auditRepository() {
  return focusPolicyFiles().flatMap(file => auditFocusRefetch(file, readFileSync(file, 'utf8')))
}
