import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'nitro'
import type { ModuleOptions as WorkflowOptions } from 'workflow/nitro'
import { configuredDeploymentId } from '../../lib/deployment-id.mjs'
import { apiAliases } from './compat-aliases.mjs'
import { nodeRuntimePackages, routeFunctionRules, workflowNodeExternals } from './build-contract.mjs'
import { publicAssetConfiguration } from './public-assets.mjs'
import { nodeRequestAuthority, vercelRequestAuthority } from './request-authority-module.mjs'
import { builtinServices } from './builtin-services-module.mjs'
import { workflowDevelopmentAliases } from './workflow-development-aliases.mjs'

const root = fileURLToPath(new URL('../..', import.meta.url))
const revision = process.env.MIKKA_BUILD_REVISION || process.env.VERCEL_GIT_COMMIT_SHA || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('API_BUILD_SHA_REQUIRED')
const build = process.env.NEXT_PUBLIC_MIKKA_BUILD || process.env.VERCEL_DEPLOYMENT_ID || revision
const assets = await publicAssetConfiguration(root)

export default defineConfig({
  workspaceDir: root,
  serverDir: false,
  builder: 'rolldown',
  buildDir: `${root}/node_modules/.cache/mikka-api`,
  modules: [workflowNodeExternals, 'workflow/nitro', workflowDevelopmentAliases, vercelRequestAuthority, nodeRequestAuthority, builtinServices],
  plugins: [`${root}/apps/api/plugins/security-headers.ts`, `${root}/apps/api/plugins/workflow-world.ts`, `${root}/apps/api/plugins/eve-service.ts`],
  routes: { '/**': `${root}/apps/api/runtime/entry.ts` },
  ...assets,
  manifest: { deploymentId: configuredDeploymentId() },
  alias: apiAliases,
  rolldownConfig: { external: nodeRuntimePackages },
  traceDeps: nodeRuntimePackages.map(name => `${name}*`),
  // Only validated public Wikimedia projections enter this mount. Keep the
  // existing one-day fresh / background-revalidate policy across Functions.
  ...((process.env.NITRO_PRESET === 'vercel' || process.env.VERCEL) ? {
    kv: { 'cache:public-wikimedia-images:v1': { driver: 'vercel-runtime-cache', base: 'mikka:public-wikimedia-images:v1' } },
  } : {}),
  workflow: { dirs: ['.'], runtime: 'nodejs24.x', sourcemap: false, dashboard: false } satisfies WorkflowOptions,
  vercel: { functions: { runtime: 'nodejs24.x' }, functionRules: await routeFunctionRules(root) },
  replace: {
    'process.env.MIKKA_UI_OVERLAY_SHA': JSON.stringify(process.env.MIKKA_UI_OVERLAY_SHA ?? ''),
    'process.env.MIKKA_BASE_PATH': JSON.stringify('/mikka'),
    'process.env.NEXT_PUBLIC_MIKKA_BUILD': JSON.stringify(build),
    'process.env.MIKKA_TEST_BUILD_SHA': JSON.stringify(process.env.MIKKA_TEST_DEPLOYMENT_SHA ?? ''),
    'process.env.NEXT_PUBLIC_COMPUTER_DEPLOYMENT': JSON.stringify(process.env.VERCEL_ENV ?? ''),
  },
  sourcemap: false,
  compatibilityDate: '2026-11-05',
})
