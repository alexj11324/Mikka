import { verifyBearer } from '@/lib/linear-sync/webhook'
import { cleanupCredentialInputs } from '@/lib/credentials/cleanup'
import { credentialFailure, privateHeaders } from '@/lib/credentials/http'
export async function GET(request: Request) {
  if (!process.env.CRON_SECRET || !await verifyBearer(request.headers.get('authorization'), process.env.CRON_SECRET)) return new Response(null, { status: 401 })
  try { return Response.json(await cleanupCredentialInputs(), { headers: privateHeaders }) }
  catch (error) { return credentialFailure(error) }
}
