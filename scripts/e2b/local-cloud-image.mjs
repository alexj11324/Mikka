import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, readlink, symlink, realpath, cp, chown, chmod, rm } from 'node:fs/promises'
import { dirname, join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalE2BProcesses } from '../../tests/fakes/e2b-process.mjs'
import { startExternalServices } from '../../tests/fakes/external-services.mjs'
import { buildCloudWorker } from '../../packages/daemon/scripts/build-cloud-worker.mjs'

/** Prepare the fake provider's preinstalled image from this immutable public
 * checkout. Worker/broker/CLI bytes actually execute; no command, registration,
 * policy, report, or ingress proof is scripted. Only E2B HTTP is substituted.
 * Run the owning local application and database in the same dedicated netns. */
export async function startLocalCloudImage({ release, ca, env = {}, root = resolve(import.meta.dirname, '../..') }) {
  assert.equal(process.getuid?.(), 0, 'LOCAL_CLOUD_IMAGE_REQUIRES_ROOT')
  const networkNamespace = await readlink('/proc/self/ns/net')
  assert.notEqual(networkNamespace, await readlink('/proc/1/ns/net'), 'LOCAL_CLOUD_IMAGE_REQUIRES_OWNED_NETWORK_NAMESPACE')
  assert.match(release.sourceCommit, /^[a-f0-9]{40}$/)
  assert.match(release.workerHash, /^[a-f0-9]{40}$/)
  const directory = await mkdtemp(join(tmpdir(), 'mikka-cloud-image-'))
  const bundle = join(directory, 'cloud'), dependencyRoot = await realpath(join(root, 'node_modules'))
  const require = createRequire(join(root, 'packages/daemon/package.json'))
  const sdkRequire = createRequire(require.resolve('@anthropic-ai/claude-agent-sdk'))
  const binary = await realpath(join(dirname(sdkRequire.resolve('@anthropic-ai/claude-agent-sdk-linux-x64/package.json')), 'claude'))
  const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex')
  const modules = await Promise.all(['pino', '@anthropic-ai/claude-agent-sdk'].map(async name => {
    let entry
    try { entry = require.resolve(`${name}/package.json`) } catch { entry = require.resolve(name) }
    const source = await realpath(dirname(entry)), path = relative(dependencyRoot, source)
    assert.ok(path && !path.startsWith('..'), 'LOCAL_CLOUD_DEPENDENCY_OUTSIDE_INSTALL')
    return { name, target: `/mikka-dependencies/${path}` }
  }))
  const before = process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
  process.env.MIKKA_CLOUD_WORKER_BUILD_SHA = release.workerHash
  try { await buildCloudWorker(bundle) } finally {
    if (before === undefined) delete process.env.MIKKA_CLOUD_WORKER_BUILD_SHA
    else process.env.MIKKA_CLOUD_WORKER_BUILD_SHA = before
  }
  const guard = await readFile(join(root, 'packages/daemon/scripts/workspace-ingress.py'))
  let guardOwner, guardEvidence, processes, services
  try {
    processes = await createLocalE2BProcesses({ networkAdministration: true,
      env: { ...env, NODE_EXTRA_CA_CERTS: '/opt/mikka/fixture-ca.pem', SSL_CERT_FILE: '/opt/mikka/fixture-ca.pem' },
      mounts: () => [{ source: dependencyRoot, target: '/mikka-dependencies' }, { source: dirname(binary), target: '/cli' },
        ...(guardOwner ? [{ source: guardOwner, target: '/run/mikka-workspace-ingress' }] : [])],
      async prepare({ sandbox, root: guest }) {
        assert.ok(['desktop', 'claude'].includes(sandbox.template), 'LOCAL_CLOUD_IMAGE_TEMPLATE_UNAVAILABLE')
        const releaseRoot = join(guest, 'opt/mikka/releases', release.sourceCommit), source = join(releaseRoot, 'source')
        for (const path of ['packages/daemon/dist', 'packages/daemon/node_modules']) await mkdir(join(source, path), { recursive: true, mode: 0o755 })
        await cp(bundle, join(source, 'packages/daemon/dist/cloud'), { recursive: true })
        for (const item of modules) {
          const link = join(source, 'packages/daemon/node_modules', item.name)
          await mkdir(dirname(link), { recursive: true }); await symlink(item.target, link)
        }
        await writeFile(join(source, '.mikka-original-cli.json'), JSON.stringify({ version: 1, kind: sandbox.template,
          original: { claude_code: { path: '/cli/claude', sha256: binaryHash }, codex: null }, added: {} }), { mode: 0o444 })
        await writeFile(join(releaseRoot, 'worker-ready.sha'), release.workerHash + '\n', { mode: 0o444 })
        await writeFile(join(guest, 'opt/mikka/worker-source-sha'), release.workerHash + '\n', { mode: 0o444 })
        await symlink(`/opt/mikka/releases/${release.sourceCommit}/source`, join(guest, 'opt/mikka/worker'))
        for (const path of ['opt/mikka/runtime/harness-bin', 'opt/mikka/runtime/ingress-v1', 'run/mikka-viewer', 'run/mikka-workspace-ingress', 'home/user/.mikka/worker']) await mkdir(join(guest, path), { recursive: true })
        await symlink(dirname(dirname(process.execPath)), join(guest, 'opt/mikka/runtime/node'))
        await writeFile(join(guest, 'opt/mikka/runtime/ingress-v1/guard.py'), guard, { mode: 0o444 })
        await writeFile(join(guest, 'opt/mikka/fixture-ca.pem'), ca, { mode: 0o444 })
        await chmod(join(guest, 'run/mikka-workspace-ingress'), 0o700)
        await chown(join(guest, 'run/mikka-viewer'), 0, 1000); await chmod(join(guest, 'run/mikka-viewer'), 0o710)
        for (const path of ['home/user/.mikka', 'home/user/.mikka/worker']) { await chown(join(guest, path), 1000, 1000); await chmod(join(guest, path), 0o700) }
        const journal = join(guest, 'home/user/.mikka/worker/runs.json')
        await writeFile(journal, '{"version":1,"runs":{}}\n', { mode: 0o600 }); await chown(journal, 1000, 1000)
      },
    })
    const create = processes.create
    const prepared = { ...processes, async create(sandbox) {
      const instance = await create(sandbox)
      // There is one real test network boundary. Its first root owner prepares
      // the unchanged guard before any worker; later fake VMs receive a read-
      // only bind of that same owned receipt directory, never a fabricated or
      // rewritten proof. Each independently executes the normal verifier.
      const action = guardOwner ? 'verify' : 'prepare'
      const job = await processes.start(sandbox, { cmd: '/bin/bash', args: ['-c', `python3 /opt/mikka/runtime/ingress-v1/guard.py ${action}`] }, { user: 'root', stdin: false })
      const code = job.exited ?? await new Promise(resolve => job.on('event', event => { if (event.type === 'end') resolve(event.exitCode) }))
      assert.equal(code, 0, 'LOCAL_CLOUD_IMAGE_INGRESS_FAILED')
      if (!guardOwner) {
        guardOwner = join(instance.root, 'run/mikka-workspace-ingress')
        guardEvidence = JSON.parse(await readFile(join(guardOwner, 'receipt.json'), 'utf8'))
      }
      return instance
    } }
    // The real root listener is also the provider port checked by the guard.
    services = await startExternalServices({ port: 49983, e2b: { processes: prepared, templates: ['desktop', 'claude'] } })
    return { ...services, worker: { ...release, cliSha256: binaryHash, networkNamespace }, get guardEvidence() { return guardEvidence },
      async close() { await services.close(); await rm(directory, { recursive: true, force: true }) } }
  } catch (error) {
    await services?.close(); if (!services) await processes?.close()
    await rm(directory, { recursive: true, force: true }); throw error
  }
}
