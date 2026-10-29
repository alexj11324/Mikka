const productionServer = 'https://app.aspectlylabs.com/mikka'

/** The package name is release configuration, chosen before publishing. */
export function daemonCommands(input: { origin: string; basePath: string; packageName: string }) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(input.packageName)) {
    throw new Error('Invalid daemon package name')
  }
  const origin = new URL(input.origin)
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid application origin')
  if (input.basePath && !/^\/(?:[A-Za-z0-9_-]+\/?)+$/.test(input.basePath)) throw new Error('Invalid application base path')
  const server = `${origin.origin}${input.basePath.replace(/\/$/, '')}`
  const flag = server === productionServer ? '' : ` --server '${server}'`
  return {
    install: `npm install --global ${input.packageName}`,
    login: `mikka daemon login${flag}`,
    start: `mikka daemon${flag}`,
  }
}
