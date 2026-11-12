import { readTaskEvidenceTarget, taskEvidenceHref } from './task-factory-events'
import { desktopWebTarget } from './desktop-web-target'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const mobileMembersPage = '/settings/members'
/** A plugin's id, as the web's ?app= takes it (TOOLKIT_SLUG in lib/composio-accounts.ts). */
const APP = /^[a-z][a-z0-9_]{0,63}$/

/**
 * The web pages the iOS app may open signed in (app/api/mobile/open): the
 * Coordinator chat, a bot's chat, a task, Settings, 插件 and one plugin's
 * page (where an app connects), or an HTML artifact's frame. Anything else becomes the home
 * page, so the handoff cannot be pointed at another site or an auth endpoint.
 * Paths are without the base path.
 */
export function mobileWebTarget(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  const url = new URL(value, 'https://mikka.invalid')
  const evidence = readTaskEvidenceTarget(url.searchParams)
  if (evidence && url.pathname === '/' && url.origin === 'https://mikka.invalid' && !url.hash && [...url.searchParams].length === 3)
    return taskEvidenceHref(evidence.issueId, evidence.factoryTaskId, evidence.receiptId)!
  const desktop = desktopWebTarget(value)
  if (desktop) return desktop
  if (url.origin === 'https://mikka.invalid' && url.pathname === '/settings' && !url.search && !url.hash) return '/settings'
  // Recovery stays within existing settings sections and one validated
  // workspace. The settings APIs still authorize that workspace normally.
  const settingsSection = url.searchParams.get('section')
  const settingsWorkspace = url.searchParams.get('workspace')
  if (settingsWorkspace && UUID.test(settingsWorkspace) && value === `${mobileMembersPage}?workspace=${settingsWorkspace}`)
    return `${mobileMembersPage}?workspace=${settingsWorkspace.toLowerCase()}`
  const settingsKeys = [...url.searchParams.keys()]
  if (url.origin === 'https://mikka.invalid' && url.pathname === '/settings' && !url.hash && settingsKeys.every(key => key === 'section' || key === 'workspace') && settingsKeys.length === (settingsWorkspace ? 2 : 1) && (!settingsWorkspace || UUID.test(settingsWorkspace)) && (settingsSection === 'computers' || settingsSection === 'models' || settingsSection === 'billing')) return `/settings?section=${settingsSection}${settingsWorkspace ? `&workspace=${settingsWorkspace.toLowerCase()}` : ''}`
  // An HTML artifact's page (资料库 on a bot's page): the viewer's sandboxed frame.
  const frame = /^\/api\/artifacts\/([0-9a-f-]{36})\/versions\/([1-9][0-9]{0,5})\/frame$/i.exec(url.pathname)
  if (url.origin === 'https://mikka.invalid' && frame && UUID.test(frame[1]) && !url.search && !url.hash) return `/api/artifacts/${frame[1].toLowerCase()}/versions/${frame[2]}/frame`
  if (url.origin !== 'https://mikka.invalid' || url.pathname !== '/' || url.hash) return '/'
  const keys = [...url.searchParams.keys()]
  const section = url.searchParams.get('section')
  const bot = url.searchParams.get('bot')
  const workspace = url.searchParams.get('workspace')
  const issue = url.searchParams.get('issue')
  if (section === 'coordinator' && keys.every(key => key === 'section' || key === 'bot' || key === 'workspace') && keys.length === 1 + (bot ? 1 : 0) + (workspace ? 1 : 0) && (!bot || UUID.test(bot)) && (!workspace || UUID.test(workspace))) return `/?section=coordinator${bot ? `&bot=${bot.toLowerCase()}` : ''}${workspace ? `&workspace=${workspace.toLowerCase()}` : ''}`
  if (issue && UUID.test(issue) && keys.length === 1) return `/?issue=${issue.toLowerCase()}`
  const app = url.searchParams.get('app')
  if (section === 'plugins' && keys.length === 1) return '/?section=plugins'
  if (section === 'plugins' && app && APP.test(app) && keys.length === 2) return `/?section=plugins&app=${app}`
  return '/'
}
