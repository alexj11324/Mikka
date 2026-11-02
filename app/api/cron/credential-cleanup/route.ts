import { cronUnauthorized } from '@/lib/cron-auth'
import { cleanupCredentialInputs } from '@/lib/credentials/cleanup'
import { credentialFailure, privateHeaders } from '@/lib/credentials/http'
export async function GET(request: Request) {
  const refused = await cronUnauthorized(request); if (refused) return refused
  try { return Response.json(await cleanupCredentialInputs(), { headers: privateHeaders }) }
  catch (error) { return credentialFailure(error) }
}
