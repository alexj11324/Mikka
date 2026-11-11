import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build, createNitro, prepare } from 'nitro/builder'
import { productWorkflowDirectories } from '../build-contract.mjs'

const repository = fileURLToPath(new URL('../../../', import.meta.url))

test('main World compiles product workflows and lib steps while excluding generated Eve sources', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'mikka-workflow-source-boundary-'))
  const previous = process.cwd()
  let nitro
  try {
    // The native SWC cache is cwd-relative; this fixture owns its own cache.
    process.chdir(root)
    await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'workflow-source-boundary-fixture', type: 'module', private: true }))
    for (const directory of ['workflows', 'lib', 'apps/eve/.eve/snapshots', 'apps/eve/.output']) await mkdir(join(root, directory), { recursive: true })
    await writeFile(join(root, 'workflows/product.ts'), `import { nonce } from '../lib/nonce';
import { SubscriptionWorkflowModel } from ${JSON.stringify(join(repository, 'lib/subscription-workflow-model.ts'))};
export async function product() {
  'use workflow'
  const model = new SubscriptionWorkflowModel({type:'subscription',bindingId:'10000000-0000-4000-8000-000000000001',ownerId:'fixture',consumerId:'10000000-0000-4000-8000-000000000002',workspaceId:'10000000-0000-4000-8000-000000000003',connectionId:'10000000-0000-4000-8000-000000000004',connectionRevision:1,modelId:'fixture',route:'codex_cpa'})
  return { nonce: await nonce(), model }
}
`)
    await writeFile(join(root, 'lib/nonce.ts'), "export async function nonce() {\n  'use step'\n  const { randomUUID } = await import('node:crypto')\n  return randomUUID()\n}\n")
    // A broad repository scan would compile these incompatible foreign World
    // entries and fail on their Node imports before building the main server.
    const foreign = "import { readFileSync } from 'node:fs'; export async function foreignWorld() {\n  'use workflow'\n  return readFileSync('/foreign-world')\n}\n"
    await writeFile(join(root, 'apps/eve/.eve/snapshots/authored.ts'), foreign)
    await writeFile(join(root, 'apps/eve/.output/authored.ts'), foreign)
    const fallback = join(root, 'fallback.mjs')
    await writeFile(fallback, "export default () => new Response('fixture')\n")
    nitro = await createNitro({ rootDir: root, workspaceDir: root, serverDir: false, preset: 'node-server', builder: 'rolldown', logLevel: 0,
      routes: { '/**': fallback }, modules: [fileURLToPath(import.meta.resolve('workflow/nitro'))],
      workflow: { dirs: productWorkflowDirectories, sourcemap: false, dashboard: false },
      buildDir: join(root, 'build'), output: { dir: join(root, 'output') }, sourcemap: false, compatibilityDate: '2026-11-05',
    }, { dotenv: false })
    await prepare(nitro); await build(nitro)
    const workflow = JSON.parse(await readFile(join(root, 'build/workflow/workflows.mjs.__wf_tmp.js.debug.json'), 'utf8'))
    const steps = JSON.parse(await readFile(join(root, 'build/workflow/steps.mjs.debug.json'), 'utf8'))
    assert.ok(workflow.workflowFiles.includes(join(root, 'workflows/product.ts')))
    assert.ok(steps.stepFiles.includes(join(root, 'lib/nonce.ts')))
    assert.doesNotMatch(JSON.stringify([workflow, steps]), /apps\/eve/)
  } finally { await nitro?.close(); process.chdir(previous); await rm(root, { recursive: true, force: true }) }
})
