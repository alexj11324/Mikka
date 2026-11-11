import { build } from 'esbuild'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const entries = { business: 'business-world', eve: 'node-world' }

/** Produce a portable adapter that the official Node World loader imports. */
export async function buildCloudflareWorld(workload, output) {
  if (!Object.hasOwn(entries, workload) || !output) throw new Error('Expected a business or eve World and an output path')
  const outfile = resolve(output)
  await mkdir(dirname(outfile), { recursive: true })
  await build({
    entryPoints: [fileURLToPath(new URL('../packages/eve-cloudflare-world/src/' + entries[workload] + '.mjs', import.meta.url))],
    outfile, bundle: true, format: 'esm', platform: 'node', target: 'node24',
    banner: { js: "import { createRequire as createBundledRequire } from 'node:module'; const require = createBundledRequire(import.meta.url);" },
  })
  return outfile
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { workload: { type: 'string' }, output: { type: 'string' } } })
  await buildCloudflareWorld(values.workload, values.output)
}
