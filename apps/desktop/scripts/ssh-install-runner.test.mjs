import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { frontendConfig } from '../../frontend/vite.config.mjs'

test('the SSH preload acceptance opts into the undistributed public renderer while release builds still require the official checkout', async () => {
  const commands = []
  const manifest = '{"version":"fixture"}'
  const source = readFileSync(new URL('../../../tests/ssh-install/run.mjs', import.meta.url), 'utf8')
  runInNewContext(source.replace(/^import .*\n/gm, ''), {
    execFileSync: (program, args, options) => {
      commands.push({ program, args, options })
      if (args[0] === 'packages/daemon/scripts/build.mjs') return 'Retained build directory: /tmp/ssh-daemon-fixture'
      if (program === 'npm') return '[{"filename":"mikka-fixture.tgz"}]'
      return ''
    },
    mkdtempSync: () => '/tmp/ssh-runner-fixture',
    readFileSync: path => { assert.equal(path, 'packages/daemon/package.json'); return manifest },
    writeFileSync: () => {}, rmSync: () => {}, tmpdir, join,
    process: { execPath: process.execPath, env: {} },
  }, { filename: 'tests/ssh-install/run.mjs', timeout: 2000 })
  const build = commands.find(command => command.args[0] === 'apps/desktop/scripts/build.mjs')
  assert.ok(build, 'the actual SSH runner still builds the installed preload')
  const names = ['MIKKA_UI_OVERLAY_DIR', 'MIKKA_UI_OVERLAY_SHA', 'VERCEL', 'VERCEL_ENV']
  const previous = names.map(name => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    await assert.rejects(frontendConfig({ target: 'desktop' }), /OFFICIAL_DESKTOP_UI_CHECKOUT_REQUIRED/)
    await frontendConfig({ target: 'desktop', publicTestFixture: build.args.includes('--public-test-fixture') })
    process.env.VERCEL_ENV = 'production'
    await assert.rejects(frontendConfig({ target: 'desktop', publicTestFixture: true }), /PUBLIC_FIXTURE_REQUIRES_NON_RELEASE_BUILD/)
  } finally {
    names.forEach((name, index) => { if (previous[index] === undefined) delete process.env[name]; else process.env[name] = previous[index] })
  }
})
