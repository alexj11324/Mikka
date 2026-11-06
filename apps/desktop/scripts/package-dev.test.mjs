import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { devPackageEnvironment } from './package-dev.mjs'

test('Dev ad-hoc signing cannot inherit release credentials and does not mutate the parent environment', () => {
  const source = {
    PATH: '/tools', MIKKA_DESKTOP_APP_URL: 'https://test.example/mikka', MIKKA_DESKTOP_FLAVOR: 'prod',
    CSC_LINK: 'secret', CSC_KEY_PASSWORD: 'secret', CSC_NAME: 'release', CSC_KEYCHAIN: 'release',
    CSC_FOR_PULL_REQUEST: 'false', CSC_IDENTITY_AUTO_DISCOVERY: 'true', WIN_CSC_LINK: 'secret',
    APPLE_ID: 'secret', APPLE_API_KEY: 'secret', APPLE_API_ISSUER: 'secret', APPLE_KEYCHAIN_PROFILE: 'secret',
  }
  const env = devPackageEnvironment(source)
  assert.equal(env.MIKKA_DESKTOP_FLAVOR, 'dev')
  assert.equal(env.PATH, source.PATH)
  assert.equal(env.CSC_FOR_PULL_REQUEST, 'true')
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, 'false')
  assert.equal(JSON.stringify(env).includes('secret'), false)
  assert.deepEqual(Object.keys(env).filter(key => /^(?:(?:WIN_)?CSC_|APPLE_)/.test(key)).sort(), ['CSC_FOR_PULL_REQUEST', 'CSC_IDENTITY_AUTO_DISCOVERY'])
  assert.equal(source.CSC_FOR_PULL_REQUEST, 'false')
  assert.equal(source.CSC_LINK, 'secret')
})

test('Dev build still requires an explicit isolated credential-free backend', () => {
  for (const url of [undefined, 'http://test.example', 'https://name:password@test.example', 'https://app.aspectlylabs.com/mikka', 'https://mikka.vercel.app/mikka']) {
    assert.throws(() => devPackageEnvironment({ MIKKA_DESKTOP_APP_URL: url }))
  }
  assert.equal(devPackageEnvironment({ MIKKA_DESKTOP_APP_URL: 'http://localhost:3000/mikka' }).MIKKA_DESKTOP_APP_URL, 'http://localhost:3000/mikka')
})

test('ad-hoc library validation exception is confined to Dev and inherited acceptance packaging', async () => {
  const [production, development, acceptance, productionEntitlements, devEntitlements] = await Promise.all([
    '../electron-builder.yml', '../electron-builder.dev.yml', '../electron-builder.acceptance.yml',
    '../build/entitlements.mac.plist', '../build/entitlements.dev.mac.plist',
  ].map(path => readFile(new URL(path, import.meta.url), 'utf8')))
  assert.match(development, /identity: '-'/)
  assert.match(development, /hardenedRuntime: true/)
  assert.match(development, /entitlements: build\/entitlements\.dev\.mac\.plist/)
  assert.match(development, /entitlementsInherit: build\/entitlements\.dev\.mac\.plist/)
  assert.match(acceptance, /extends: electron-builder\.dev\.yml/)
  assert.match(production, /entitlements: build\/entitlements\.mac\.plist/)
  assert.doesNotMatch(production, /identity: '-'/)
  assert.doesNotMatch(productionEntitlements, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>/)
  assert.match(devEntitlements, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\/>/)
})

test('each flavor declares only its own sign-in link scheme after electron-builder merges extends', async () => {
  const builderRequire = createRequire(createRequire(import.meta.url).resolve('electron-builder/package.json'))
  const { getConfig } = builderRequire('app-builder-lib/out/util/config/config.js')
  const root = fileURLToPath(new URL('..', import.meta.url))
  const schemes = async file => {
    const { protocols } = await getConfig(root, join(root, file), null)
    return [protocols].flat().flatMap(protocol => protocol.schemes)
  }
  assert.deepEqual(await schemes('electron-builder.yml'), ['mikka-auth'])
  assert.deepEqual(await schemes('electron-builder.dev.yml'), ['mikka-dev-auth'])
  assert.deepEqual(await schemes('electron-builder.acceptance.yml'), ['mikka-dev-auth'])
})
