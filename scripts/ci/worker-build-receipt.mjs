import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
const output = process.argv[2]
if (!output) throw new Error('Worker output directory required')
const bundle = readFileSync(join(output, 'index.js'))
const receipt = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim(),
  trackedDiff: execFileSync('git', ['diff', '--stat', 'HEAD'], { encoding: 'utf8' }).trim(),
  node: process.version,
  bundle: 'worker-build/index.js',
  bytes: bundle.length,
  gzipBytes: gzipSync(bundle).length,
  sha256: createHash('sha256').update(bundle).digest('hex'),
  scope: 'Wrangler dry-run only; no Cloudflare deployment or live provider acceptance',
}
writeFileSync(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify(receipt, null, 2))
