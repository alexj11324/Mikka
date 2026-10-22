// PostHog project tokens are public ingestion identifiers; keep them in deployment configuration.
export const posthogConfig = {
  token: process.env.NEXT_PUBLIC_POSTHOG_KEY ?? '',
  apiHost: 'https://us.i.posthog.com',
  uiHost: 'https://us.posthog.com',
} as const
