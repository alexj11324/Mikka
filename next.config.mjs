import createNextIntlPlugin from 'next-intl/plugin'
import { withWorkflow } from 'workflow/next'
import { basePath } from './lib/base-path-config.mjs'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

// The app lives at app.aspectlylabs.com/mikka. lib/base-path.ts reads this
// back for the places Next does not prefix on its own.

/** @type {import('next').NextConfig} */
const nextConfig = {
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
  env: { MIKKA_BASE_PATH: basePath },
  async redirects() {
    return [
      // The app's previous address; keep its links working.
      { source: '/:path*', has: [{ type: 'host', value: 'mikka.aspectlylabs.com' }], destination: `https://app.aspectlylabs.com${basePath}/:path*`, basePath: false, permanent: true },
      { source: '/', destination: basePath, basePath: false, permanent: false },
      // OAuth discovery for agents signing in to the MCP server (app/api/mcp).
      // RFC 8414 and RFC 9728 put the documents at the origin's root with the
      // issuer or resource path appended; they live under the base path.
      // Older MCP clients look at the bare root path.
      ...['', `${basePath}/api/auth`].map(issuerPath => ({ source: `/.well-known/oauth-authorization-server${issuerPath}`, destination: `${basePath}/.well-known/oauth-authorization-server`, basePath: false, permanent: false })),
      { source: `/.well-known/oauth-protected-resource${basePath}/api/mcp`, destination: `${basePath}/.well-known/oauth-protected-resource`, basePath: false, permanent: false },
    ]
  },
  transpilePackages: ['@mikka/protocol'],
  serverExternalPackages: ['ai', 'better-auth', 'drizzle-orm'],
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }, // next-intl can land the reset link on a locale-prefixed page; it carries the token too.
      ...['/api/auth/verify-email', '/verify-email', '/:locale(en|zh-CN)/verify-email', '/api/auth/reset-password/:path*', '/reset-password/:path*', '/:locale(en|zh-CN)/reset-password/:path*'].map(source => ({
      source,
      headers: [
        { key: 'Referrer-Policy', value: 'no-referrer' },
        { key: 'Cache-Control', value: 'no-store' },
      ],
    }))]
  },
  experimental: {
    globalNotFound: true,
  },
  images: {
    unoptimized: true,
  },
}

export default withWorkflow(withNextIntl(nextConfig))
