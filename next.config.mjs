import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

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
  transpilePackages: ['@mikka/protocol'],
  serverExternalPackages: ['ai', '@ai-sdk/openai-compatible', 'better-auth', 'drizzle-orm'],
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }]
  },
  experimental: {
    globalNotFound: true,
  },
  images: {
    unoptimized: true,
  },
}

export default withNextIntl(nextConfig)
