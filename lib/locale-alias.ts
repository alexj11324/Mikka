/** `/zh` and `/zh-cn` are not configured locales. Send them to `zh-CN`. */
export function localeAliasPath(pathname: string) {
  if (/^\/zh-CN(?=\/|$)/.test(pathname)) return null
  const match = /^\/(?:zh|zh-cn)(?=\/|$)/i.exec(pathname)
  if (!match) return null
  const rest = pathname.slice(match[0].length)
  return `/zh-CN${rest}`
}
