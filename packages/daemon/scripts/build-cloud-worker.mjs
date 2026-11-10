// Compile the trusted worker while building the template, never on a cold run.
// Keep native SDKs external and preserve the same helper layout as the daemon
// package build; import.meta.url in the bundled worker resolves beside them.
import { existsSync, realpathSync } from 'node:fs'
import { copyFile, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { WORKER_BOOTSTRAP_BROKER_SOURCE } from '../src/cloud-bootstrap-broker.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
// SDKs with native binaries/relative runtime assets stay installed. Bundle
// ordinary JS dependencies (including zod/AI SDK) to avoid thousands of cold
// filesystem reads after a filesystem-only snapshot boot.
const external = ['@anthropic-ai/claude-agent-sdk', 'pino']
export async function buildCloudWorker(out = resolve(root, 'dist/cloud')) {
  const result = await build({
    absWorkingDir: root, entryPoints: ['bin/cloud-worker.ts', 'bin/cloud-model-probe.ts'], outdir: out,
    // Separate bundles keep the catalogue entry free of the worker's SDK graph.
    bundle: true, splitting: false, platform: 'node', format: 'esm', target: 'node24',
    banner: { js: 'import { createRequire as mikkaCreateRequire } from "node:module"; const require = mikkaCreateRequire(import.meta.url);' },
    define: { __MIKKA_DAEMON_BUNDLE__: 'true' },
    external: external.flatMap(name => [name, `${name}/*`]), logLevel: 'warning', metafile: true,
  })
  for (const path of ['agents/native-container.mjs', 'computer/proxy.mjs', 'computer/driver.mjs']) {
    await mkdir(dirname(resolve(out, path)), { recursive: true })
    await copyFile(resolve(root, 'src', path), resolve(out, path))
  }
  for (const path of ['mikka-mcp.mjs', 'mikka-mcp-context.mjs', 'mikka-mcp-backend.mjs', 'mikka-mcp-worker.mjs', 'capture-copy.mjs', 'github-credentials.mjs', 'native-tool-isolation.mjs']) {
    await copyFile(resolve(root, 'src/agents', path), resolve(out, path))
  }
  await cp(resolve(root, 'fixtures'), resolve(out, 'fixtures'), { recursive: true })
  await rm(resolve(out, 'bootstrap-broker.mjs'), { force: true })
  await writeFile(resolve(out, 'bootstrap-broker.mjs'), WORKER_BOOTSTRAP_BROKER_SOURCE, { mode: 0o444 })
  // This declaration belongs to the actual compiled worker source. A newer
  // installer cannot advertise capabilities for an older checkout/build script.
  const workerSha = process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
  const capability = resolve(out, 'runtime-capabilities.json')
  if (workerSha !== undefined) {
    if (!/^[a-f0-9]{40}$/.test(workerSha)) throw new Error('Invalid worker build identity')
    await rm(capability, { force: true })
    await writeFile(capability, JSON.stringify({ registrationNoticeVersion: 1, workerSha }) + '\n', { mode: 0o444 })
  } else await rm(capability, { force: true })
  return result.metafile
}

if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await buildCloudWorker()
