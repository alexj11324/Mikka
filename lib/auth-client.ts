'use client'
import { createAuthClient } from 'better-auth/react'
import { multiSessionClient } from 'better-auth/client/plugins'
import { withBasePath } from '@/lib/base-path'
export const authClient = createAuthClient({ basePath: withBasePath('/api/auth'), plugins: [multiSessionClient()] })
