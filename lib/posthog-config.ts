// PostHog project tokens are public ingestion identifiers; keep them in deployment configuration.
export const posthogConfig = {
  token: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
  apiHost: (process.env.POSTHOG_HOST || process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com').replace(/\/+$/, ''),
  uiHost: 'https://us.posthog.com',
} as const
