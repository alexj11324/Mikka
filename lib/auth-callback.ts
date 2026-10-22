export type SocialProvider = 'github' | 'google'

export function authCallbackURL(baseURL: string | undefined, provider: SocialProvider, basePath = '') {
  return baseURL ? `${baseURL.replace(/\/$/, '')}${basePath}/api/auth/callback/${provider}` : undefined
}
