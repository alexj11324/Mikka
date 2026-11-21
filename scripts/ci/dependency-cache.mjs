import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Only installation inputs, never generated node_modules or application output.
const manifest = /^(?:package\.json|(?:apps|packages)\/[^/]+\/package\.json)$/
const input = /(?:^|\/)(?:package\.json|\.npmrc|\.pnpmfile\.[cm]?js)$|^pnpm-(?:lock|workspace)\.yaml$|^patches\/|^\.github\/actions\/pnpm-install\/|^scripts\/ci\/dependency-cache\.mjs$/
const lifecycle = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'pnpm:devPreinstall']

export function dependencyCache(root, context) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(file => file && input.test(file)).sort()
  const hash = createHash('sha256').update(JSON.stringify({ root: resolve(root), ...context }))
  let reusable = true
  for (const file of files) {
    const content = readFileSync(resolve(root, file))
    hash.update('\0' + file + '\0').update(content)
    if (manifest.test(file)) {
      const { scripts = {} } = JSON.parse(content)
      if (lifecycle.some(name => scripts[name])) reusable = false
    }
    // A hook can read arbitrary source files. Do not guess its dependency set.
    if (/(?:^|\/)\.pnpmfile\.[cm]?js$/.test(file)) reusable = false
  }
  return { key: `pnpm-modules-v1-${context.platform}-${context.arch}-${hash.digest('hex')}`, reusable }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = dependencyCache(process.cwd(), {
    node: process.versions.node, platform: process.platform, arch: process.arch,
    pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
    image: process.env.ImageOS ?? '', profile: process.env.INSTALL_PROFILE,
    electron: process.env.ELECTRON_SKIP_BINARY_DOWNLOAD ?? '',
    nodeEnv: process.env.NODE_ENV ?? '',
  })
  for (const [name, value] of Object.entries(result)) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}
