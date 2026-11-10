import { execFileSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import createNextIntlPlugin from 'next-intl/plugin'
import { withWorkflow } from 'workflow/next'
import { basePath } from './lib/base-path-config.mjs'
import { configuredDeploymentId } from './lib/deployment-id.mjs'
import { localTestAccountsMode } from './packages/protocol/src/local-test-mode.ts'
import { overlayAliases } from './lib/ui-overlay.mjs'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

// lib/app-build.ts: the deployment a page was built by. Vercel's deployment id,
// else the commit; an empty value turns the stale-page check off.
function appBuild() {
  if (process.env.VERCEL_DEPLOYMENT_ID) return process.env.VERCEL_DEPLOYMENT_ID
  if (process.env.VERCEL_GIT_COMMIT_SHA) return process.env.VERCEL_GIT_COMMIT_SHA
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return '' }
}

// The app lives at app.aspectlylabs.com/mikka. lib/base-path.ts reads this
// back for the places Next does not prefix on its own.

// Vercel Skew Protection for the prebuilt production upload: only the production
// workflow sets MIKKA_DEPLOYMENT_ID (lib/deployment-id.mjs). Next 16 sends it as
// x-deployment-id on Server Action and RSC requests, so an open page keeps
// reaching its own deployment after the next deploy.
const deploymentId = configuredDeploymentId()

// UI slots: today's components, or the hosted layer's when MIKKA_UI_OVERLAY_DIR
// is set (docs/ui-overlay.md).
const uiSlots = overlayAliases(dirname(fileURLToPath(import.meta.url)))

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(deploymentId ? { deploymentId } : {}),
  // next dev would rewrite AGENTS.md with its own block; the file is the project's
  // (https://nextjs.org/docs/app/api-reference/config/next-config-js/agentRules).
  agentRules: false,
  // pnpm build runs the CI typechecker after Next generates its route types.
  typescript: { ignoreBuildErrors: true },
  outputFileTracingIncludes: {
    '/*': ['./lib/abuse/data/disposable-email-domains.txt', './packages/daemon/scripts/official-e2b-instance-bootstrap.sh', './packages/daemon/scripts/refresh-cloud-worker.py'],
    '/api/bots/*/subagents/**': ['./scripts/e2b/*.py', './scripts/e2b/*.mjs', './scripts/e2b/*.sh'],
    '/api/threads/**': ['./scripts/e2b/*.py', './scripts/e2b/*.mjs', './scripts/e2b/*.sh'],
    '/api/tasks/*/review/**': ['./scripts/e2b/*.py'],
    '/api/factory/tasks/**': ['./scripts/e2b/inspect-retained-deliverable.mjs'],
    '/.well-known/workflow/**': ['./scripts/e2b/*.py', './scripts/e2b/*.mjs', './scripts/e2b/*.sh'],
    '/api/bots/*/computer/*': ['./scripts/e2b/start-desktop.sh', './scripts/e2b/viewer-gateway.py', './scripts/e2b/lease-driver.py'],
    '/api/workspaces/**': ['./scripts/e2b/lease-driver.py'],
    '/v1/runs/*/screen': ['./scripts/e2b/screen-capture.sh'],
    '/api/subscriptions/**': ['./packages/subscription-worker/bin/mikka-subscription-worker', './packages/subscription-worker/bin/mikka-subscription-enrollment'],
    '/api/cron/subscriptions': ['./packages/subscription-worker/bin/mikka-subscription-worker'],
    '/v1/devices/**/subscription': ['./packages/subscription-worker/bin/mikka-subscription-worker'],
  },
  turbopack: {
    resolveAlias: {
      'react-syntax-highlighter': './components/workspace/agent-syntax-highlighter.tsx',
      ...uiSlots.turbopack,
    },
  },
  webpack(config, { dev }) {
    // The dev filesystem cache serializes the ~24k-module graph into ~2 GB of
    // buffers and does not make a restart much faster (docs/dev-workflow.md).
    if (dev) config.cache = { type: 'memory' }
    config.resolve.alias['react-syntax-highlighter$'] = new URL('./components/workspace/agent-syntax-highlighter.tsx', import.meta.url).pathname
    for (const [specifier, file] of Object.entries(uiSlots.absolute)) config.resolve.alias[`${specifier}$`] = file
    if (uiSlots.dir) config.resolve.alias['@hosted'] = uiSlots.dir
    return config
  },
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 8,
  },
  basePath,
  env: { MIKKA_BASE_PATH: basePath, NEXT_PUBLIC_MIKKA_BUILD: appBuild(), NEXT_PUBLIC_COMPUTER_DEPLOYMENT: process.env.VERCEL_ENV ?? '', MIKKA_TEST_BUILD_SHA: process.env.MIKKA_TEST_DEPLOYMENT_SHA ?? '' },
  async redirects() {
    return [
      // The app's previous address; keep its links working.
      { source: '/:path*', has: [{ type: 'host', value: 'mikka.aspectlylabs.com' }], destination: `https://app.aspectlylabs.com${basePath}/:path*`, basePath: false, permanent: true },
      { source: '/', destination: basePath, basePath: false, permanent: false },
      // Devices is one section of Settings, not a page of its own (Figma 503:7105).
      { source: '/devices', destination: '/settings?section=devices', permanent: false },
      { source: '/:locale(en|zh-CN)/devices', destination: '/:locale/settings?section=devices', permanent: false },
      // OAuth discovery for agents signing in to the MCP server (app/api/mcp).
      // RFC 8414 and RFC 9728 put the documents at the origin's root with the
      // issuer or resource path appended; they live under the base path.
      // Older MCP clients look at the bare root path.
      ...['', `${basePath}/api/auth`].map(issuerPath => ({ source: `/.well-known/oauth-authorization-server${issuerPath}`, destination: `${basePath}/.well-known/oauth-authorization-server`, basePath: false, permanent: false })),
      { source: `/.well-known/oauth-protected-resource${basePath}/api/mcp`, destination: `${basePath}/.well-known/oauth-protected-resource`, basePath: false, permanent: false },
    ]
  },
  transpilePackages: ['@mikka/protocol'],
  // better-auth/react must share Next's SSR React dispatcher with client components.
  // Externalizing the whole package loads native React and crashes enabled analytics.
  // OpenTelemetry stays external so the pg instrumentation can patch the `pg` that lib/db requires (lib/tracing/node.ts).
  serverExternalPackages: ['ai', 'drizzle-orm', 'officeparser', '@e965/xlsx', 'music-metadata', '@opentelemetry/api', '@opentelemetry/instrumentation', '@opentelemetry/instrumentation-pg', '@opentelemetry/sdk-trace-node', '@opentelemetry/exporter-trace-otlp-proto'],
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }, // next-intl can land the reset link on a locale-prefixed page; it carries the token too.
      ...['/api/auth/verify-email', '/verify-email', '/:locale(en|zh-CN)/verify-email', '/api/auth/reset-password/:path*', '/reset-password/:path*', '/:locale(en|zh-CN)/reset-password/:path*', '/api/auth/device', '/api/auth/device/:path*', '/device', '/:locale(en|zh-CN)/device'].map(source => ({
      source,
      headers: [
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
      ],
    }))]
  },
  experimental: {
    // Three page-data workers exceeded the standard 8 GB production builder.
    cpus: 1,
    globalNotFound: true,
    // Bulk add in 设置 › 密钥与环境 sends a .env of up to 2 MB (lib/secrets/dotenv.ts) to a server action;
    // the default limit is 1 MB. 3 MB leaves room for the multipart envelope.
    serverActions: { bodySizeLimit: '3mb' },
    // Pages must carry the build-time id above, the one Vercel pins prebuilt
    // deployments by, not the runtime dpl_ id (vercel/next.js#94734).
    ...(deploymentId ? { runtimeServerDeploymentId: false } : {}),
    // A copied acceptance checkout can invalidate Turbopack's persistent
    // parent graph and abort next dev. Keep this disposable stack in memory.
    ...(localTestAccountsMode(process.env) ? { turbopackFileSystemCacheForDev: false } : {}),
  },
  images: {
    unoptimized: true,
  },
}

const workflowConfig = withWorkflow(withNextIntl(nextConfig))

export default async function config(phase, context) {
  const resolved = await workflowConfig(phase, context)
  if (phase !== 'phase-production-build') return resolved
  // The 8 GB Vercel build machine runs out of memory at "Collecting page data"
  // (docs/dev-workflow.md). Nothing reads production source maps, which cost
  // ~750 MB to generate, and the workflow bundles are built by now, so the
  // esbuild service need not stay up for the rest of the build.
  const esbuild = await import('esbuild')
  esbuild.stop()
  return { ...resolved, experimental: { ...resolved.experimental, turbopackSourceMaps: false } }
}
