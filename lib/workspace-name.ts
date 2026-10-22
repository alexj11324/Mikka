import en from '@/messages/en.json'
import zh from '@/messages/zh-CN.json'

export type WorkspaceLocale = 'en' | 'zh-CN'

const templates: Record<WorkspaceLocale, { named: string; mine: string }> = {
  en: { named: en.Members.defaultWorkspaceName, mine: en.Members.myWorkspace },
  'zh-CN': { named: zh.Members.defaultWorkspaceName, mine: zh.Members.myWorkspace },
}

export function defaultWorkspaceName(locale: WorkspaceLocale, userName: string | null | undefined) {
  const name = userName?.trim()
  if (!name) return templates[locale].mine
  return templates[locale].named.replaceAll('{name}', name)
}

/** Returns the current locale's generated name when `stored` is exactly an auto-generated name for this user in another locale. */
export function renameGeneratedWorkspace(stored: string, locale: WorkspaceLocale, userName: string | null | undefined) {
  const next = defaultWorkspaceName(locale, userName)
  if (stored === next) return null
  const generated = (['en', 'zh-CN'] as const).some(item => stored === defaultWorkspaceName(item, userName))
  return generated ? next : null
}
