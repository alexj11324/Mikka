import { cronUnauthorized } from '@/lib/cron-auth'
import { cronJob } from '@/lib/background'
import { cleanupCredentialInputs } from '@/lib/credentials/cleanup'
import { credentialFailure, privateHeaders } from '@/lib/credentials/http'
async function handleGET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try { return Response.json(await cleanupCredentialInputs(), { headers: privateHeaders }) }
  catch (error) { return credentialFailure(error) }
}

export const GET = cronJob('credential-cleanup', handleGET)
