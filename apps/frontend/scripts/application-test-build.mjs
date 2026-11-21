import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'vite'
import { applicationPlugin, repository } from './application-plugin.mjs'

export async function compileApplication(source, target = 'web', external = []) {
  const directory = await mkdtemp(join(tmpdir(), 'mikka-vite-contract-'))
  const entry = join(directory, 'contract.ts')
  await writeFile(entry, source)
  const plugin = await applicationPlugin(target)
  try {
    const output = await build({
      configFile: false, root: repository, publicDir: false, envDir: false, envPrefix: [], logLevel: 'silent',
      plugins: [plugin],
      define: { 'process.env.NODE_ENV': '"production"', 'process.env.MIKKA_BASE_PATH': '"/mikka"', 'process.env': '{}' },
      build: { write: false, minify: false, target: 'es2023', rolldownOptions: { input: entry, external, preserveEntrySignatures: 'strict' } },
    })
    const entryChunk = output.output.find(chunk => chunk.type === 'chunk' && chunk.isEntry)
    assert.ok(entryChunk)
    return { code: entryChunk.code, inventory: plugin.api.inventory() }
  } finally { await rm(directory, { recursive: true, force: true }) }
}
