import 'server-only'
import { actAs } from '@/lib/acting-user'
import { FactoryError } from './contract'
import { withFactoryWorkspace } from './workspace-reader'

type FactoryUser = Exclude<Parameters<typeof actAs>[0], string>

/** Run inside the existing authenticated actor. Admission owns the Workspace
 * lease before any Factory application transaction starts. */
export async function factoryWorkspaceResponse(userId: string | undefined, work: () => Promise<Response>): Promise<Response> {
  try {
    return userId ? await withFactoryWorkspace(userId, work) : await work()
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'factoryNotFound') {
      return Response.json({ error: 'factoryNotFound' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
    }
    throw error
  }
}

/** Preserve the complete verified session/PAT principal at human adapters. */
export function factoryHumanWorkspaceResponse(user: FactoryUser | null | undefined, work: () => Promise<Response>): Promise<Response> {
  return user ? actAs(user, () => factoryWorkspaceResponse(user.id, work)) : work()
}
