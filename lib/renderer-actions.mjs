import assert from 'node:assert/strict'

export const rendererActionName = /^[a-z][a-z0-9-]*\.[A-Za-z][A-Za-z0-9]*$/

export function publishedActions(manifest) {
  assert.equal(manifest?.version, 1, 'The public action manifest must have a supported version')
  assert.equal(manifest.target, 'web', 'The observed manifest must belong to the web build')
  assert.ok(Array.isArray(manifest.usedActions) && manifest.usedActions.length > 0 && manifest.usedActions.length <= 1000)
  assert.ok(manifest.usedActions.every(name => typeof name === 'string' && rendererActionName.test(name)))
  assert.equal(new Set(manifest.usedActions).size, manifest.usedActions.length)
  return new Set(manifest.usedActions)
}

export function rendererActionContract(inventory) {
  const actions = publishedActions(inventory)
  assert.match(inventory.rendererBuild, /^[a-f0-9]{64}$/)
  const modules = new Map()
  for (const action of actions) {
    const [name, exported] = action.split('.')
    const registered = Object.hasOwn(inventory.modules, name) && inventory.modules[name]
    assert.ok(Array.isArray(registered) && registered.filter(value => value === exported).length === 1,
      'Published action is absent from the compiler module inventory')
    if (!modules.has(name)) modules.set(name, [])
    modules.get(name).push(exported)
  }
  return { version: 1, target: 'web', rendererBuild: inventory.rendererBuild,
    usedActions: [...actions], modules: Object.fromEntries(modules) }
}

/** Older deployments publish the action inventory in the full build manifest.
 * Cloudflare keeps that file private and serves only the release-bound action contract. */
export async function readRendererActions(request, prefix = '', pin) {
  const query = pin ? '?dpl=' + encodeURIComponent(pin) : ''
  const legacy = await request(prefix + '/renderer-manifest.json' + query)
  if (legacy.status !== 404) return legacy
  await legacy.body?.cancel?.()
  return request(prefix + '/renderer-actions.json' + query)
}
