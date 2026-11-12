import assert from 'node:assert/strict'
import { test } from 'node:test'
import { frontendConfig } from '../vite.config.mjs'
import { browserModule } from './test-module.mjs'

async function environment(values, run) {
  const saved = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  try { for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } return await run() }
  finally { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value } }
}

test('only the existing explicit public configuration is defined for the web graph', async () => environment({ PRIVATE_SOURCE_CANARY: 'not-public', NEXT_PUBLIC_UNLISTED_CANARY: 'not-public', MIKKA_DEPLOYMENT_ID: 'release-1', NEXT_DEPLOYMENT_ID: undefined, NEXT_PUBLIC_MIKKA_BUILD: 'a'.repeat(40) }, async () => {
  const config = await frontendConfig()
  assert.equal(config.envDir, false)
  assert.deepEqual(config.envPrefix, [])
  assert.equal(config.define['process.env'], '{}')
  assert.equal(config.define['process.env.NEXT_PUBLIC_MIKKA_BUILD'], JSON.stringify('a'.repeat(40)))
  assert.equal(config.define['process.env.MIKKA_DEPLOYMENT_ID'], '"release-1"')
  assert.equal(JSON.stringify(config.define).includes('not-public'), false)
  assert.deepEqual(Object.keys(config.define).filter(key => key.startsWith('process.env.NEXT_PUBLIC_')).sort(), [
    'NEXT_PUBLIC_MIKKA_BUILD',
    'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
    'NEXT_PUBLIC_TURNSTILE_SITE_KEY',
    'NEXT_PUBLIC_POSTHOG_HOST',
    'NEXT_PUBLIC_POSTHOG_KEY',
    'NEXT_PUBLIC_COMPUTER_ACCEPTANCE',
    'NEXT_PUBLIC_COMPUTER_DEPLOYMENT',
    'NEXT_PUBLIC_COMPUTER_ENABLED',
    'NEXT_PUBLIC_COMPUTER_MOCK',
    'NEXT_PUBLIC_MIKKA_DAEMON_PACKAGE_NAME',
  ].map(key => `process.env.${key}`).sort())
}))

test('the production explicit computer rollout follows VERCEL_ENV without requiring PostHog', async () => environment({ VERCEL_ENV: 'production', NEXT_PUBLIC_COMPUTER_DEPLOYMENT: undefined, NEXT_PUBLIC_COMPUTER_ENABLED: '1', NEXT_PUBLIC_POSTHOG_KEY: undefined }, async () => {
  const config = await frontendConfig()
  const flags = await browserModule('export { computerProductionEnabled } from "./lib/feature-flags.ts"', config.define)
  assert.equal(JSON.parse(config.define['process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT']), 'production')
  assert.equal(flags.computerProductionEnabled(JSON.parse(config.define['process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT']), JSON.parse(config.define['process.env.NEXT_PUBLIC_COMPUTER_ENABLED'])), true)
  assert.equal(JSON.parse(config.define['process.env.NEXT_PUBLIC_POSTHOG_KEY']), '')
}))

test('desktop remains unpinned and does not initialize browser analytics or browser auth configuration', async () => environment({ MIKKA_DEPLOYMENT_ID: 'release-1', NEXT_PUBLIC_MIKKA_BUILD: 'a'.repeat(40), NEXT_PUBLIC_POSTHOG_KEY: 'public-canary', NEXT_PUBLIC_TURNSTILE_SITE_KEY: 'public-widget' }, async () => {
  const config = await frontendConfig({ target: 'desktop', publicTestFixture: true })
  for (const key of ['MIKKA_DEPLOYMENT_ID', 'NEXT_PUBLIC_MIKKA_BUILD', 'NEXT_PUBLIC_POSTHOG_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY']) assert.equal(config.define[`process.env.${key}`], '""')
  assert.deepEqual(config.experimental, {})
}))

test('the actual web flag graph follows the explicit deployment stage while desktop remains server-owned', async () => {
  for (const stage of ['production', 'preview', 'development']) await environment({ MIKKA_DEPLOYMENT_STAGE: stage, VERCEL_ENV: 'production', NEXT_PUBLIC_COMPUTER_ENABLED: '1' }, async () => {
    const web = await frontendConfig()
    const deployment = JSON.parse(web.define['process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT'])
    assert.equal(deployment, stage)
    const flags = await browserModule('export { computerProductionEnabled } from "./lib/feature-flags.ts"', web.define)
    assert.equal(flags.computerProductionEnabled(deployment, '1'), stage === 'production')
    // Exercise the public test renderer without representing a release with a
    // missing private checkout. The explicit application stage remains set.
    const desktop = await environment({ VERCEL_ENV: undefined }, () => frontendConfig({ target: 'desktop', publicTestFixture: true }))
    assert.equal(desktop.define['process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT'], '""')
  })
  await environment({ MIKKA_DEPLOYMENT_STAGE: 'prod' }, async () => assert.rejects(frontendConfig(), /MIKKA_DEPLOYMENT_STAGE_INVALID/))
})

test('Vite development keeps the actual development React runtime and Fast Refresh plugin', async () => {
  const config = await frontendConfig({ command: 'serve' })
  assert.equal(config.define['process.env.NODE_ENV'], '"development"')
  assert.equal(config.define['process.env.MIKKA_DEPLOYMENT_ID'], '""')
  assert.ok(config.plugins.flat(Infinity).some(plugin => /react/.test(plugin.name)))
  await assert.rejects(frontendConfig({ target: 'server' }), /FRONTEND_TARGET_INVALID/)
})

test('a server-pages build cannot package a private release or a desktop renderer', async () => {
  await assert.rejects(frontendConfig({ target: 'desktop', serverPages: true }), /SERVER_PAGES_REQUIRE_PUBLIC_WEB_BUILD/)
  for (const key of ['MIKKA_UI_OVERLAY_DIR', 'MIKKA_UI_OVERLAY_SHA']) {
    await environment({ [key]: 'configured' }, async () => {
      await assert.rejects(frontendConfig({ serverPages: true }), /SERVER_PAGES_REQUIRE_PUBLIC_WEB_BUILD/)
    })
  }
})

test('standalone package entry points require a private revision for official Desktop and Web', async () => {
  await environment({ MIKKA_UI_OVERLAY_DIR: undefined, MIKKA_UI_OVERLAY_SHA: undefined, VERCEL: undefined, VERCEL_ENV: undefined }, async () => {
    await assert.rejects(frontendConfig({ target: 'desktop' }), /OFFICIAL_DESKTOP_UI_CHECKOUT_REQUIRED/)
    await frontendConfig({ target: 'desktop', publicTestFixture: true })
    await environment({ VERCEL: '1', VERCEL_ENV: 'production' }, async () => {
      await assert.rejects(frontendConfig(), /OFFICIAL_UI_CHECKOUT_AND_REVISION_REQUIRED/)
      await assert.rejects(frontendConfig({ publicTestFixture: true }), /PUBLIC_FIXTURE_REQUIRES_NON_RELEASE_BUILD/)
    })
    await environment({ MIKKA_UI_OVERLAY_DIR: '.missing-official-checkout' }, async () => {
      await assert.rejects(frontendConfig({ target: 'desktop' }), /OFFICIAL_UI_CHECKOUT_AND_REVISION_REQUIRED/)
      await assert.rejects(frontendConfig({ publicTestFixture: true }), /PUBLIC_FIXTURE_REQUIRES_NON_RELEASE_BUILD/)
    })
  })
})
