import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'

export type WorkspaceLocale = 'en' | 'zh-CN'

const templates: Record<WorkspaceLocale, { named: string; mine: string }> = {
  en: { named: en.Members.defaultWorkspaceName, mine: en.Members.myWorkspace },
  'zh-CN': { named: zh.Members.defaultWorkspaceName, mine: zh.Members.myWorkspace },
}

/** Chinese text puts a space between a Latin or digit run and a Han character: 「Ada 的工作区」, 「张三的工作区」. */
const LATIN_END = /[\p{Script=Latin}\p{Nd}]$/u
const HAN_START = /^\p{Script=Han}/u
function fillName(template: string, name: string, spaced: boolean) {
  return template.replace(/\{name\}([\s\S]?)/g, (_, next: string) => `${name}${spaced && LATIN_END.test(name) && HAN_START.test(next) ? ' ' : ''}${next}`)
}

export function defaultWorkspaceName(locale: WorkspaceLocale, userName: string | null | undefined) {
  const name = userName?.trim()
  if (!name) return templates[locale].mine
  return fillName(templates[locale].named, name, true)
}

/** Returns the current locale's generated name when `stored` is exactly an auto-generated name for this user in another locale. */
export function renameGeneratedWorkspace(stored: string, locale: WorkspaceLocale, userName: string | null | undefined) {
  const next = defaultWorkspaceName(locale, userName)
  if (stored === next) return null
  const name = userName?.trim()
  // Names generated before the Latin–Han space (「Ada的工作区」) still count as generated.
  const generated = (['en', 'zh-CN'] as const).some(item => stored === defaultWorkspaceName(item, userName) || (!!name && stored === fillName(templates[item].named, name, false)))
  return generated ? next : null
}
