// Focus is stale-while-revalidate, never a re-query
// (docs/design/decisions/2026-11-01-0400-no-refetch-on-focus.md). The site's
// SWR defaults (components/swr-defaults.tsx) revalidate on focus only data
// older than its freshness threshold, silently; hooks do not turn focus on
// themselves. Third-party connection status never revalidates on focus.
// Hand-written focus, visibility or app-state listeners are allowed by file,
// each with its reason.
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
  'apps/mobile/lib/useApi.ts': 'pauses polling in the background; on return one silent read only past FRESH_FOR_MS',
}

/** Third-party connection status (GitHub, Composio): every SWR hook here sets revalidateOnFocus: false. */
export const thirdPartyStatusFiles = [
  'components/plugins/github-settings.tsx',
  'components/plugins/connected-apps.tsx',
  'components/workspace/issue-pull-request-link.tsx',
]

/** The one place focus revalidation is configured, behind its freshness gate. */
export const swrDefaultsFile = 'components/swr-defaults.tsx'

const rules = [
  { rule: 'focus/swr-revalidate-on-focus', pattern: /\brevalidateOnFocus\s*:\s*true\b/g, message: '不要在单个 hook 打开 revalidateOnFocus：全站默认已按新鲜度阈值静默重验（components/swr-defaults.tsx）。' },
  { rule: 'focus/refresh-when-hidden', pattern: /\brefreshWhenHidden\s*:(?!\s*false\b)/g, message: '轮询只在页面可见时运行：refreshWhenHidden 只能是 false。' },
  { rule: 'focus/refetch-on-window-focus', pattern: /\brefetchOnWindowFocus\s*:(?!\s*false\b)/g, message: 'refetchOnWindowFocus 只能是 false：聚焦不重查数据。' },
  { rule: 'focus/focus-manager', pattern: /\bfocusManager\b/g, message: '不用 focusManager 在聚焦时重查。' },
  { rule: 'focus/listener', listener: true, pattern: /\baddEventListener\(\s*['"](?:focus|visibilitychange|pageshow)['"]/g, message: '聚焦、可见或回到页面时不重查数据；真需要监听（动画等）就加入 focusListenerAllowlist 并写明原因。' },
  { rule: 'focus/listener', listener: true, pattern: /\bAppState\.addEventListener\(\s*['"]change['"]/g, message: '回到前台时不重查数据；真需要监听就加入 focusListenerAllowlist 并写明原因。' },
]

export function auditFocusRefetch(file, source) {
  const diagnostics = []
  if (thirdPartyStatusFiles.includes(file)) {
    const hooks = source.match(/\buseSWR(?:Infinite)?\s*(?:<[^>]*>)?\(/g)?.length ?? 0
    const off = source.match(/\brevalidateOnFocus\s*:\s*false\b/g)?.length ?? 0
    if (off < hooks) diagnostics.push({ file, line: 1, column: 1, rule: 'focus/third-party-status', message: '第三方连接状态只在进入页面、用户操作和交接完成信号后读取：每个 useSWR 都要 revalidateOnFocus: false。' })
  }
  for (const { rule, pattern, message, listener } of rules) {
    if (listener && Object.hasOwn(focusListenerAllowlist, file)) continue
    if (file === swrDefaultsFile && rule === 'focus/swr-revalidate-on-focus') continue
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
