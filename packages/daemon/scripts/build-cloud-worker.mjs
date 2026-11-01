// Compile the trusted worker while building the template, never on a cold run.
// Keep native SDKs external and preserve the same helper layout as the daemon
// package build; import.meta.url in the bundled worker resolves beside them.
import { copyFile, cp, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const out = resolve(root, 'dist/cloud')
// SDKs with native binaries/relative runtime assets stay installed. Bundle
// ordinary JS dependencies (including zod/AI SDK) to avoid thousands of cold
// filesystem reads after a filesystem-only snapshot boot.
const external = ['@anthropic-ai/claude-agent-sdk', '@anthropic-ai/sandbox-runtime', 'pino']
await build({
  absWorkingDir: root, entryPoints: ['bin/cloud-worker.ts'], outfile: resolve(out, 'cloud-worker.js'),
  bundle: true, platform: 'node', format: 'esm', target: 'node24',
  banner: { js: 'import { createRequire as mikkaCreateRequire } from "node:module"; const require = mikkaCreateRequire(import.meta.url);' },
  define: { __MIKKA_DAEMON_BUNDLE__: 'true' },
  external: external.flatMap(name => [name, `${name}/*`]), logLevel: 'warning',
})
for (const path of ['agents/native-container.mjs', 'agents/native-egress.mjs', 'agents/run-container-entry.mjs', 'computer/proxy.mjs', 'computer/driver.mjs']) {
  await mkdir(dirname(resolve(out, path)), { recursive: true })
  await copyFile(resolve(root, 'src', path), resolve(out, path))
}
for (const path of ['mikka-mcp.mjs', 'capture-copy.mjs', 'github-credentials.mjs', 'run-sandbox-worker.mjs']) {
  await copyFile(resolve(root, 'src/agents', path), resolve(out, path))
}
await cp(resolve(root, 'fixtures'), resolve(out, 'fixtures'), { recursive: true })
