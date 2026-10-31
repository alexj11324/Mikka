const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The web pages the iOS app may open signed in (app/api/mobile/open): the
 * Coordinator chat, a bot's chat, a task, or Settings (where apps connect). Anything else becomes the home
 * page, so the handoff cannot be pointed at another site or an auth endpoint.
 * Paths are without the base path.
 */
export function mobileWebTarget(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/'
  const url = new URL(value, 'https://mikka.invalid')
  if (url.origin === 'https://mikka.invalid' && url.pathname === '/settings' && !url.search && !url.hash) return '/settings'
  if (url.origin !== 'https://mikka.invalid' || url.pathname !== '/' || url.hash) return '/'
  const keys = [...url.searchParams.keys()]
  const section = url.searchParams.get('section')
  const bot = url.searchParams.get('bot')
  const issue = url.searchParams.get('issue')
  if (section === 'coordinator' && keys.length === 1) return '/?section=coordinator'
  if (section === 'coordinator' && bot && UUID.test(bot) && keys.length === 2) return `/?section=coordinator&bot=${bot.toLowerCase()}`
  if (issue && UUID.test(issue) && keys.length === 1) return `/?issue=${issue.toLowerCase()}`
  return '/'
}
