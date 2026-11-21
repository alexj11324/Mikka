import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('a production-mode compiled flag module cannot be re-enabled by runtime environment overrides', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-production-flags-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const outfile = join(directory, 'flags.mjs')
  await build({ entryPoints: [new URL('./feature-flags.ts', import.meta.url).pathname], outfile,
    bundle: true, platform: 'node', format: 'esm', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' } })
  const { localFlagOverride, productionFlagDefault } = await import(pathToFileURL(outfile).href)
  const prior = { node: process.env.NODE_ENV, flags: process.env.MIKKA_FLAG_OVERRIDES }
  try {
    process.env.NODE_ENV = 'test'
    for (const flags of ['{"mikka-cloud-computer":false}', 'not-json']) {
      process.env.MIKKA_FLAG_OVERRIDES = flags
      assert.equal(localFlagOverride('mikka-cloud-computer'), undefined)
      assert.equal(productionFlagDefault('mikka-cloud-computer'), true)
    }
  } finally {
    for (const [name, value] of [['NODE_ENV', prior.node], ['MIKKA_FLAG_OVERRIDES', prior.flags]]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
})
