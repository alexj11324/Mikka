'use client'

import type { AuthSsoProps } from '@/components/slots/auth-sso-contract'

/**
 * Public server sign-in pages use this empty contract. The official SSO
 * provider starts Better Auth's /sign-in/sso (#1642).
 */
export function AuthSso(_props: AuthSsoProps) { return null }
