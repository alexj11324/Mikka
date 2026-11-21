import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import test from 'node:test'
import { applicationPlugin, repository } from './application-plugin.mjs'

test('redirected and canonical imports retain the same complete resolution metadata', async () => {
  const plugin = await applicationPlugin('web')
  const id = resolve(repository, 'lib/client-runtime/localized-navigation.tsx')
  const importer = resolve(repository, 'components/auth-form.tsx')
  const options = { isEntry: false, attributes: { type: 'javascript' } }
  const resolved = { id, moduleSideEffects: false, meta: { packageJsonPath: resolve(repository, 'package.json') } }
  const calls = []
  const context = { async resolve(source, parent, selected) {
    calls.push({ source, parent, selected })
    return resolved
  } }
  const redirected = await plugin.resolveId.call(context, '@/i18n/navigation', importer, options)
  const canonical = await plugin.resolveId.call(context, '@/lib/client-runtime/localized-navigation', importer, options)
  assert.equal(redirected, resolved, 'a redirect must retain package format and side-effect metadata')
  assert.equal(canonical, resolved)
  assert.deepEqual(calls, [id, id.slice(0, -4)].map(source => ({ source, parent: importer, selected: { ...options, skipSelf: true } })))
})
