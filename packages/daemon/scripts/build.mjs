import { appendFile, chmod, copyFile, cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// Keep this build script inside the daemon's packaged source boundary.
const repository = process.env.GITHUB_REPOSITORY_ID === '1427517699'
  && [['alexj11324/Mikka', '183887963'], ['aspectly-labs/Mikka', '359279274']].some(([name, ownerId]) =>
    process.env.GITHUB_REPOSITORY === name && process.env.GITHUB_REPOSITORY_OWNER_ID === ownerId)
  ? process.env.GITHUB_REPOSITORY : 'alexj11324/Mikka'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const packageName = process.env.MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka'
if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error('Invalid daemon npm package name')
const out = await mkdtemp(join(root, '.retained-build-'))
console.log(`Retained build directory: ${out}`)
const { build } = await import('esbuild')

// Runtime SDKs retain their assets and native dependencies. The private
// workspace protocol and the MCP client's pure JS graph are bundled. The MCP
// SDK is consumed through its client subpaths; its root export is not usable.
const bundled = new Set(['@mikka/protocol', '@modelcontextprotocol/sdk'])
const dependencies = Object.fromEntries(Object.entries(source.dependencies).filter(([name]) => !bundled.has(name)))
const entryPoints = {
  mikka: 'bin/mikka.ts', main: 'src/main.ts', cli: 'src/cli.ts',
  client: 'src/rpc/client.ts', env: 'src/env.ts', paths: 'src/paths.ts',
  'http-link': 'src/server-link-http.ts', login: 'src/login.ts', log: 'src/log.ts',
  sandbox: 'src/agents/sandbox.ts',
}
const result = await build({
  absWorkingDir: root, entryPoints, outdir: out, bundle: true,
  platform: 'node', format: 'esm', target: 'node22',
  // The MCP stdio client includes CommonJS helpers which require Node builtins.
  banner: { js: 'import { createRequire as mikkaCreateRequire } from "node:module"; const require = mikkaCreateRequire(import.meta.url);' },
  // No shared chunks: import.meta.url is relative to the emitted entry,
  // keeping the existing hosted helper paths stable.
  splitting: false, sourcemap: false,
  define: { __MIKKA_DAEMON_BUNDLE__: 'true' },
  external: Object.keys(dependencies).flatMap(name => [name, `${name}/*`]),
  logLevel: 'warning', metafile: true,
})
for (const path of ['agents/native-container.mjs', 'computer/proxy.mjs', 'computer/driver.mjs']) {
  await mkdir(dirname(resolve(out, path)), { recursive: true })
  await copyFile(resolve(root, 'src', path), resolve(out, path))
}
// run-context is bundled into each root entry; its stdio helper is standalone.
await copyFile(resolve(root, 'src/agents/mikka-mcp.mjs'), resolve(out, 'mikka-mcp.mjs'))
await copyFile(resolve(root, 'src/agents/mcp-stdio-launcher.mjs'), resolve(out, 'mcp-stdio-launcher.mjs'))
await copyFile(resolve(root, 'src/agents/mikka-mcp-backend.mjs'), resolve(out, 'mikka-mcp-backend.mjs'))
await copyFile(resolve(root, 'src/agents/mikka-mcp-worker.mjs'), resolve(out, 'mikka-mcp-worker.mjs'))
await copyFile(resolve(root, 'src/agents/mikka-mcp-context.mjs'), resolve(out, 'mikka-mcp-context.mjs'))
await copyFile(resolve(root, 'src/agents/capture-copy.mjs'), resolve(out, 'capture-copy.mjs'))
await copyFile(resolve(root, 'src/agents/github-credentials.mjs'), resolve(out, 'github-credentials.mjs'))
await cp(resolve(root, 'fixtures'), resolve(out, 'fixtures'), { recursive: true })
// The daemon's harness pins and installer (harness-install.ts).
for (const path of ['harness/pins.json', 'harness/install.mjs', 'harness/cli.mjs']) {
  await mkdir(dirname(resolve(out, path)), { recursive: true })
  await copyFile(resolve(root, path), resolve(out, path))
}
await copyFile(resolve(root, '../../LICENSE'), resolve(out, 'LICENSE'))
await copyFile(resolve(root, 'README.md'), resolve(out, 'README.md'))
await copyFile(resolve(root, 'THIRD_PARTY_NOTICES.md'), resolve(out, 'THIRD_PARTY_NOTICES.md'))
// Record the exact third-party code that esbuild included, together with its
// complete upstream license/notice files. External SDKs ship their own notices.
const bundledPackages = new Set()
for (const input of Object.keys(result.metafile.inputs)) {
  const path = resolve(root, input).replaceAll('\\', '/')
  const marker = '/node_modules/', offset = path.lastIndexOf(marker)
  if (offset < 0) continue
  const relative = path.slice(offset + marker.length).split('/')
  const packageName = relative.slice(0, relative[0].startsWith('@') ? 2 : 1)
  bundledPackages.add(resolve(path.slice(0, offset + marker.length), ...packageName))
}
for (const directory of [...bundledPackages].sort()) {
  const manifest = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'))
  const notices = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[.-].*)?$/i.test(entry.name))
    .map(entry => entry.name).sort()
  if (!notices.length) throw new Error(`Missing bundled dependency license: ${manifest.name}@${manifest.version}`)
  let notice = `\n## ${manifest.name}@${manifest.version}\n`
  for (const file of notices) notice += `\n### ${file}\n\n\`\`\`text\n${(await readFile(resolve(directory, file), 'utf8')).trimEnd()}\n\`\`\`\n`
  await appendFile(resolve(out, 'THIRD_PARTY_NOTICES.md'), notice)
}
const exports = Object.fromEntries(Object.entries(source.exports).map(([key]) => [key, `./${key === '.' ? 'main' : key.slice(2)}.js`]))
await writeFile(resolve(out, 'package.json'), `${JSON.stringify({
  name: packageName, version: source.version, description: source.description,
  gitHead: source.gitHead,
  type: 'module', private: false, license: source.license,
  engines: source.engines, bin: { mikka: './mikka.js' }, exports,
  repository: { type: 'git', url: `git+https://github.com/${repository}.git`, directory: 'packages/daemon' },
  publishConfig: { access: 'public', provenance: true }, dependencies,
}, null, 2)}\n`)
await chmod(resolve(out, 'mikka.js'), 0o755)
console.log(`Built ${packageName}@${source.version} in ${out}`)
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `package-directory=${out}\n`)
