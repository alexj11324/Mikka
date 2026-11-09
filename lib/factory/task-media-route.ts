import { auth } from '../api-auth'
import { pool } from '../db'
import { readCapturePoster } from '../captures/poster-store'
import { privateCaptureDownload } from '../captures/private-download'
import { captureFileResponse } from '../captures/serve'
import { factoryHumanStore } from './server'
import { authorizeFactoryTaskCapture } from './task-media'
import { FactoryError } from './contract'
import { factoryHumanWorkspaceResponse } from './workspace-http'
import { causeFields } from '@mikka/protocol/coded-error'

/** Task-detail session adapter, shared by originals and their derived covers.
 * Pin the complete principal and WS/member lease before any APP transaction. */
export async function serveFactoryTaskMedia(request: Request, taskId: string, captureId: string, poster = false) {
  const session = await auth.api.getSession({ headers: request.headers, query: { disableCookieCache: true } })
  const privateHeaders = { 'cache-control': 'private, no-store' }
  if (!session) return new Response(null,{ status: 401, headers: privateHeaders })
  return factoryHumanWorkspaceResponse(session.user,async () => {
    try {
      await authorizeFactoryTaskCapture(pool,factoryHumanStore,session.user.id,taskId,captureId)
      const cover = poster ? await readCapturePoster(session.user.id,captureId,request.signal) : null
      const response = poster ? (cover ? captureFileResponse(request,cover,privateHeaders) : null)
        : await privateCaptureDownload(request,session.user.id,captureId)
      // Rendering/object reads can take time. Recheck current task visibility
      // before returning bytes if its workspace/source changed meanwhile.
      if (response) await authorizeFactoryTaskCapture(pool,factoryHumanStore,session.user.id,taskId,captureId)
      return response ?? new Response(null,{ status:404,headers:privateHeaders })
    } catch (error) {
      if (error instanceof FactoryError && error.code === 'factoryNotFound') return new Response(null,{ status: 404, headers: privateHeaders })
      // Failed decoding/storage never invents a cover or discloses the input,
      // binary stderr, storage key or account data in a response.
      console.warn('[capture media] read unavailable', { causes: causeFields(error) })
      return new Response(null,{ status: 503, headers: privateHeaders })
    }
  })
}
