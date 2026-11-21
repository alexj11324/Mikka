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


// Repository IDs survive an ownership transfer. Current Actions claims must
// agree on the owner and name; original receipts keep the name they recorded.
const owners = new Map([['alexj11324', '183887963'], ['aspectly-labs', '359279274']])
export const publicRepositoryId = '1427517699'
export const operationsRepositoryId = '1448851980'

export function officialMikkaRepository(name, repositoryId, ownerId) {
  for (const [owner, id] of owners) {
    if (repositoryId === publicRepositoryId && name === owner + '/Mikka' && (ownerId === undefined || ownerId === id)) return name
  }
}

export function actionsMikkaRepository(env) {
  if (!env.GITHUB_REPOSITORY_OWNER_ID) return
  return officialMikkaRepository(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY_ID, env.GITHUB_REPOSITORY_OWNER_ID)
}

export function privateMikkaRepository(name, env = process.env) {
  const owner = (name === 'mikka-hosted-ui' && env.MIKKA_HOSTED_UI_GITHUB_OWNER) || env.MIKKA_PRIVATE_GITHUB_OWNER || 'alexj11324'
  if (!owners.has(owner) || !['mikka-cloud', 'mikka-hosted-ui'].includes(name)) throw new Error('CI_PRIVATE_REPOSITORY_OWNER_REQUIRED')
  return owner + '/' + name
}
