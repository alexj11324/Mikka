import { githubAppSlug } from './install-url'

export type GitHubAppCredentials = { id: string; slug: string; pem: string; webhookSecret: string; clientId: string; clientSecret: string }
export type GitHubAppConfig = { source: 'database' | 'environment' } & { [K in keyof GitHubAppCredentials]: string | null }

/** A pure fallback shared by deployed configuration and explicitly injected test environments. */
export function githubAppEnvironmentConfig(env: Readonly<Record<string, string | undefined>> = process.env): GitHubAppConfig {
  return {
    source: 'environment', id: env.GITHUB_APP_ID?.trim() || null, slug: githubAppSlug(env),
    pem: env.GITHUB_APP_PRIVATE_KEY || null, webhookSecret: env.GITHUB_WEBHOOK_SECRET || null,
    clientId: env.GITHUB_CLIENT_ID?.trim() || null, clientSecret: env.GITHUB_CLIENT_SECRET || null,
  }
}
