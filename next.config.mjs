import createNextIntlPlugin from 'next-intl/plugin'
import { withWorkflow } from 'workflow/next'
import { basePath } from './lib/base-path-config.mjs'
import { localTestAccountsMode } from './packages/protocol/src/local-test-mode.ts'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

// The app lives at app.aspectlylabs.com/mikka. lib/base-path.ts reads this
// back for the places Next does not prefix on its own.

/** @type {import('next').NextConfig} */
const nextConfig = {
  // next dev would rewrite AGENTS.md with its own block; the file is the project's
  // (https://nextjs.org/docs/app/api-reference/config/next-config-js/agentRules).
  agentRules: false,
  // pnpm build runs the CI typechecker after Next generates its route types.
  typescript: { ignoreBuildErrors: true },
  outputFileTracingIncludes: {
    '/*': ['./lib/abuse/data/disposable-email-domains.txt'],
    '/api/bots/*/subagents/**': ['./scripts/e2b/*.py', './scripts/e2b/*.mjs', './scripts/e2b/*.sh'],
    '/api/threads/**': ['./scripts/e2b/*.py', './scripts/e2b/*.mjs', './scripts/e2b/*.sh'],
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
    },
  },
  webpack(config) {
    config.resolve.alias['react-syntax-highlighter$'] = new URL('./components/workspace/agent-syntax-highlighter.tsx', import.meta.url).pathname
    return config
  },
  onDemandEntries: {
    maxInactiveAge: 60 * 60 * 1000,
    pagesBufferLength: 8,
  },
  basePath,
  env: { MIKKA_BASE_PATH: basePath, NEXT_PUBLIC_COMPUTER_DEPLOYMENT: process.env.VERCEL_ENV ?? '', MIKKA_TEST_BUILD_SHA: process.env.MIKKA_TEST_DEPLOYMENT_SHA ?? '' },
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
  serverExternalPackages: ['ai', 'drizzle-orm'],
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
    // A copied acceptance checkout can invalidate Turbopack's persistent
    // parent graph and abort next dev. Keep this disposable stack in memory.
    ...(localTestAccountsMode(process.env) ? { turbopackFileSystemCacheForDev: false } : {}),
  },
  images: {
    unoptimized: true,
  },
}

export default withWorkflow(withNextIntl(nextConfig))
