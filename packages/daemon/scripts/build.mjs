import { build } from 'esbuild'
import { chmod, copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
const packageName = process.env.MIKKA_DAEMON_PACKAGE_NAME ?? '@aspectlylabs/mikka'
if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(packageName)) throw new Error('Invalid daemon npm package name')
const out = resolve(root, 'dist')
await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

// Runtime SDKs retain their assets and native dependencies. The private
// workspace protocol is bundled, so installing the tarball needs no workspace.
const dependencies = Object.fromEntries(Object.entries(source.dependencies).filter(([name]) => name !== '@mikka/protocol'))
const entryPoints = {
  mikka: 'bin/mikka.ts', main: 'src/main.ts', cli: 'src/cli.ts',
  client: 'src/rpc/client.ts', env: 'src/env.ts', paths: 'src/paths.ts',
  'http-link': 'src/server-link-http.ts', login: 'src/login.ts', log: 'src/log.ts',
  sandbox: 'src/agents/sandbox.ts', coordinator: 'src/coordinator/index.ts',
}
await build({
  absWorkingDir: root, entryPoints, outdir: out, bundle: true,
  platform: 'node', format: 'esm', target: 'node24',
  // No shared chunks: import.meta.url is relative to the emitted entry,
  // keeping the existing hosted helper paths stable.
  splitting: false, sourcemap: false,
  define: { __MIKKA_DAEMON_BUNDLE__: 'true' },
  external: Object.keys(dependencies).flatMap(name => [name, `${name}/*`]),
  logLevel: 'warning',
})
for (const path of ['agents/native-container.mjs', 'computer/proxy.mjs', 'computer/driver.mjs']) {
  await mkdir(dirname(resolve(out, path)), { recursive: true })
  await copyFile(resolve(root, 'src', path), resolve(out, path))
}
// run-context is bundled into each root entry; its stdio helper is standalone.
await copyFile(resolve(root, 'src/agents/mikka-mcp.mjs'), resolve(out, 'mikka-mcp.mjs'))
await cp(resolve(root, 'fixtures'), resolve(out, 'fixtures'), { recursive: true })
await copyFile(resolve(root, '../../LICENSE'), resolve(out, 'LICENSE'))
await copyFile(resolve(root, 'README.md'), resolve(out, 'README.md'))
const exports = Object.fromEntries(Object.entries(source.exports).map(([key]) => [key, `./${key === '.' ? 'main' : key.slice(2)}.js`]))
await writeFile(resolve(out, 'package.json'), `${JSON.stringify({
  name: packageName, version: source.version, description: source.description,
  type: 'module', private: false, license: source.license,
  engines: { node: '>=24' }, bin: { mikka: './mikka.js' }, exports,
  repository: { type: 'git', url: 'git+https://github.com/alexj11324/Mikka.git', directory: 'packages/daemon' },
  publishConfig: { access: 'public', provenance: true }, dependencies,
}, null, 2)}\n`)
await chmod(resolve(out, 'mikka.js'), 0o755)
console.log(`Built ${packageName}@${source.version} in packages/daemon/dist`)
