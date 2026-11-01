// Every move inside the app window goes through one place, so the address
// always says what is on screen and back steps through it one move at a time
// (docs/design/rules.md R-82; decisions/2026-11-01-1320-navigation-model.md).
//
// - Only components/workspace/workspace-navigation.ts and
//   lib/settings-navigation.ts write the browser history.
// - A workspace address (?issue=, ?bot=, ?section=<workspace page>) is built
//   with workspaceLink / workspaceSearch / goTo, never by hand.
// - router.push / router.replace are for leaving the window (sign-in, a new
//   locale) and Settings' own fallback.
//
// The files below predate the rule and each keeps exactly the count it has,
// with its reason. A new call anywhere, or one more in these files, fails.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

/** The two modules that own the address. */
export const navigationModules = ['components/workspace/workspace-navigation.ts', 'lib/settings-navigation.ts']

/** file → rule → { count, reason } */
export const navigationAllowlist = {
  'app/api/desktop/finish/route.ts': { 'navigation/history': { count: 1, reason: 'inline script in the desktop sign-in hand-off page drops its one-time token from the address' } },
  'components/auth/reset-password-form.tsx': { 'navigation/history': { count: 1, reason: 'drops the reset token from the address after reading it' } },
  'components/auth/verify-email-form.tsx': { 'navigation/history': { count: 1, reason: 'drops the verification token from the address after reading it' } },
  'components/billing/balance-section.tsx': { 'navigation/history': { count: 1, reason: 'drops the Stripe return key after showing its result' } },
  'components/billing/free-allowance-section.tsx': { 'navigation/history': { count: 1, reason: 'drops the Stripe return key after showing its result' } },
  'components/plugins/connected-apps.tsx': { 'navigation/history': { count: 1, reason: 'drops the Composio OAuth return keys after showing the result' } },
  'components/plugins/github-settings.tsx': { 'navigation/history': { count: 1, reason: 'drops the GitHub App return keys after showing the result' } },
  'components/settings/google-sign-in-settings.tsx': { 'navigation/history': { count: 1, reason: 'drops the Google link return key after showing the result' } },
  'lib/subscription-enrollment-binding-proof.ts': { 'navigation/history': { count: 1, reason: 'script in the subscription enrollment page drops its one-time proof from the address' } },
  'lib/subscription-enrollment-handoff.ts': { 'navigation/history': { count: 1, reason: 'script in the subscription hand-off page drops its one-time key from the address' } },
  'components/workspace/issue-workspace.tsx': { 'navigation/router': { count: 5, reason: 'sign-out leaves for /sign-in; Settings opened on its own route goes back to the app when pushSettingsHistory cannot' } },
  'components/settings/settings-shell.tsx': { 'navigation/router': { count: 2, reason: 'sign-out leaves for /sign-in; Settings links fall back to the router where pushSettingsHistory cannot' } },
  'components/settings/settings-view.tsx': { 'navigation/router': { count: 1, reason: 'an unknown settings section is replaced by 通用' } },
  'components/settings/settings-preview.tsx': { 'navigation/router': { count: 6, reason: 'the signed-out Settings preview sends every control to sign-in' } },
  'components/settings/locale-setting.tsx': { 'navigation/router': { count: 1, reason: 'reloads the same page in the new language' } },
  'components/nav-user.tsx': { 'navigation/router': { count: 1, reason: 'reloads the same page in the new language' } },
  'components/workspace/members-settings.tsx': { 'navigation/router': { count: 1, reason: 'Settings › 成员 for another workspace' } },
  'components/teams/team-directory.tsx': { 'navigation/router': { count: 1, reason: 'Settings › 团队 falls back to the router where pushSettingsHistory cannot' } },
  'components/teams/team-settings-details.tsx': { 'navigation/router': { count: 1, reason: 'Settings › 团队 falls back to the router where pushSettingsHistory cannot' } },
  'components/desktop/desktop-integration.tsx': { 'navigation/router': { count: 1, reason: 'a notification link that is not a place in the app window' } },
  'lib/auth-return.ts': { 'navigation/address': { count: 3, reason: 'validates where sign-in may return to; it accepts only these exact shapes' } },
  'lib/mobile-web-target.ts': { 'navigation/address': { count: 6, reason: 'validates where the phone app may open the web; it accepts only these exact shapes' } },
  'app/api/integrations/github/connect/route.ts': { 'navigation/address': { count: 1, reason: 'sign-in return to the GitHub app page (section=plugins&app=github)' } },
  'lib/github/connect-callback.ts': { 'navigation/address': { count: 1, reason: 'the GitHub app page (section=plugins&app=github) after its install callback' } },
}

const WORKSPACE_SECTIONS = 'coordinator|agent|plugins|suggestions|artifacts|all-issues|projects'
const rules = [
  { rule: 'navigation/history', pattern: /\bhistory\.(?:pushState|replaceState)\s*\(/g, message: '不要直接写浏览器历史：用 components/workspace/workspace-navigation.ts 的 goTo / goToHref / dropQueryKeys（R-82）。' },
  { rule: 'navigation/router', pattern: /\brouter\.(?:push|replace)\s*\(/g, message: '应用窗口内的跳转不用 router.push / replace：用 goTo，或从外部入口用 openAppLink（R-82）。' },
  { rule: 'navigation/address', pattern: new RegExp(String.raw`[?&](?:issue|bot)=(?!=)|searchParams\.(?:set|append)\(\s*['"](?:issue|bot)['"]|[?&]section=(?:${WORKSPACE_SECTIONS})\b|searchParams\.(?:set|append)\(\s*['"]section['"]\s*,\s*['"](?:${WORKSPACE_SECTIONS})['"]`, 'g'), message: '不要手拼工作区地址（?issue= / ?bot= / ?section=…）：用 workspaceLink / workspaceSearch / goTo（R-82）。' },
]

/** Blanks comments so a doc line that names an address is not a finding; offsets stay put. */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, match => match.replace(/[^\n]/g, ' ')).replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (match, lead) => lead + ' '.repeat(match.length - lead.length))
}

export function auditNavigation(file, source) {
  if (navigationModules.includes(file)) return []
  const code = withoutComments(source)
  const diagnostics = []
  for (const { rule, pattern, message } of rules) {
    const found = [...code.matchAll(pattern)]
    const allowed = navigationAllowlist[file]?.[rule]?.count ?? 0
    if (found.length <= allowed) continue
    for (const match of found.slice(allowed)) {
      const before = code.slice(0, match.index)
      diagnostics.push({ file, line: before.split('\n').length, column: match.index - before.lastIndexOf('\n'), rule, message })
    }
  }
  return diagnostics
}

export function navigationPolicyFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0')
    .filter(file => /^(?:app|components|hooks|lib)\/.*\.(?:[cm]?[jt]sx?)$/.test(file) && !/\.test\.[cm]?[jt]sx?$/.test(file) && !file.endsWith('.d.ts') && existsSync(file))
}

export function auditRepository() {
  return navigationPolicyFiles().flatMap(file => auditNavigation(file, readFileSync(file, 'utf8')))
}

/** Allowlisted counts that are now higher than the file needs: lower them so a new call cannot hide in the slack. */
export function staleAllowances() {
  const stale = []
  for (const [file, entries] of Object.entries(navigationAllowlist)) {
    const code = existsSync(file) ? withoutComments(readFileSync(file, 'utf8')) : ''
    for (const [rule, { count }] of Object.entries(entries)) {
      const pattern = rules.find(item => item.rule === rule).pattern
      const found = [...code.matchAll(pattern)].length
      if (found < count) stale.push(`${file} ${rule}: allows ${count}, has ${found}`)
    }
  }
  return stale
}
