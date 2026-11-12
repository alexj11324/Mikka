export function hasGitHubOrigin(origin, repository) {
  let source
  try {
    source = new URL(origin.replace(/^git@github\.com:/i, 'ssh://git@github.com/'))
  } catch {
    console.error('MIKKA_CF_ORIGIN=' + JSON.stringify({ format: 'unrecognized' }))
    return false
  }
  const path = source.pathname.replace(/^\//, '').replace(/\/$/, '').replace(/\.git$/i, '')
  const supported = ['https:', 'ssh:'].includes(source.protocol) && source.hostname.toLowerCase() === 'github.com'
    && !source.port && !source.search && !source.hash
  const matches = supported && path.toLowerCase() === repository.toLowerCase()
  if (!matches) console.error('MIKKA_CF_ORIGIN=' + JSON.stringify({ protocol: source.protocol, host: source.hostname,
    path: path.toLowerCase() === repository.toLowerCase() ? 'expected' : 'different' }))
  return matches
}
