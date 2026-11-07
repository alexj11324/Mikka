import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'pg'
import { getEdition, isCloudEdition } from './edition'
import { HostedUsageStore } from './abuse/store'
import { githubAppInstallUrl } from './github/install-url'
import { visibleSettingsSections } from './settings-sections'

test('edition defaults to community and rejects misspelled deployment configuration', () => {
  assert.equal(getEdition({}), 'community')
  assert.equal(getEdition({ MIKKA_EDITION: 'community' }), 'community')
  assert.equal(isCloudEdition({ MIKKA_EDITION: 'cloud' }), true)
  assert.throws(() => getEdition({ MIKKA_EDITION: 'enterprise' }), /MIKKA_EDITION_INVALID/)
})

test('community own-provider usage never touches hosted billing, including beyond the free trial', async () => {
  const pool = new Proxy({}, { get() { throw new Error('community must not read or write the hosted billing database') } }) as Pool
  const usage = new HostedUsageStore(pool, {
    metered: false,
    quota: async () => { throw new Error('community must not acquire a hosted plan quota') },
  })
  assert.equal(await usage.verify('workspace', null, null), false)
  for (let index = 0; index < 40; index++) {
    assert.equal((await usage.canUseMikkaPaid('workspace')).verified, true)
    assert.deepEqual(await usage.reserve('workspace', 'own-model', String(index)), { id: String(index), workspaceId: 'workspace' })
    await usage.recordGeneration(String(index), 'own-generation')
    await usage.settle(String(index), null, 100, 20)
  }
  assert.equal(await usage.trialLeft('workspace', { verified: false, purchased: 0 }), null)
  assert.deepEqual(await usage.status('workspace'), { state: 'ready', balance: { verified: true, free: 0, purchased: 0 }, trialLeft: null })
  assert.deepEqual(await usage.recent('workspace'), [])
  assert.equal(new HostedUsageStore(pool).metered, true)
})

test('community settings omit billing, and the GitHub install target is the configured app', () => {
  assert.equal(visibleSettingsSections({ admin: true, billing: false }).some(section => section.id === 'billing'), false)
  assert.equal(visibleSettingsSections({ admin: true, billing: true }).some(section => section.id === 'billing'), true)
  assert.equal(githubAppInstallUrl({}), null)
  assert.equal(githubAppInstallUrl({ GITHUB_APP_SLUG: 'acme-mikka' }), 'https://github.com/apps/acme-mikka/installations/new')
  assert.equal(githubAppInstallUrl({ MIKKA_EDITION: 'cloud' }), 'https://github.com/apps/mikka-github/installations/new')
  for (const slug of ['../mikka-github', 'other/app', 'app?redirect=evil']) assert.equal(githubAppInstallUrl({ GITHUB_APP_SLUG: slug }), null)
})
