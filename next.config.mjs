import createNextIntlPlugin from 'next-intl/plugin'

const withNextIntl = createNextIntlPlugin('./i18n/request.ts')

// The app lives at app.aspectlylabs.com/mikka. lib/base-path.ts reads this
// back for the places Next does not prefix on its own.
const basePath = '/mikka'

/** @type {import('next').NextConfig} */
const nextConfig = {
  basePath,
  env: { MIKKA_BASE_PATH: basePath },
  async redirects() {
    return [
      // The app's previous address; keep its links working.
      { source: '/:path*', has: [{ type: 'host', value: 'mikka.aspectlylabs.com' }], destination: `https://app.aspectlylabs.com${basePath}/:path*`, basePath: false, permanent: true },
      { source: '/', destination: basePath, basePath: false, permanent: false },
    ]
  },
  transpilePackages: ['@mikka/protocol'],
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
