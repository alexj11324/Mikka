import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider'
import { metadataCorsOptionsRequestHandler } from 'mcp-handler'
import { auth } from '@/lib/auth'

/**
 * RFC 8414 metadata for the OAuth server in lib/auth.ts. Its issuer is
 * <origin>/mikka/api/auth, so clients look for
 * /.well-known/oauth-authorization-server/mikka/api/auth at the origin's root;
 * next.config.mjs redirects that path here.
 */
export const GET = oauthProviderAuthServerMetadata(auth, { headers: { 'Access-Control-Allow-Origin': '*' } })

export const OPTIONS = metadataCorsOptionsRequestHandler()
