import 'server-only'
import { actAs } from '@/lib/acting-user'
import { FactoryError } from './contract'
import { withFactoryMembership, withFactoryWorkspace } from './workspace-reader'

type FactoryUser = Exclude<Parameters<typeof actAs>[0], string>

async function factoryResponse(userId: string | undefined, work: () => Promise<Response>, admit: typeof withFactoryWorkspace): Promise<Response> {
  try {
    return userId ? await admit(userId, work) : await work()
  } catch (error) {
    if (error instanceof FactoryError && error.code === 'factoryNotFound') {
      return Response.json({ error: 'factoryNotFound' }, { status: 404, headers: { 'Cache-Control': 'private, no-store' } })
    }
    throw error
  }
}

/** Run inside the existing authenticated actor. Admission owns the Workspace
 * and Project resource leases before any Factory application transaction. */
export function factoryWorkspaceResponse(userId: string | undefined, work: () => Promise<Response>): Promise<Response> {
  return factoryResponse(userId, work, withFactoryWorkspace)
}

/** Discovery under an existing verified actor holds membership, without
 * admitting execution or serializing Project resource configuration. */
export function factoryMembershipResponse(userId: string | undefined, work: () => Promise<Response>): Promise<Response> {
  return factoryResponse(userId, work, withFactoryMembership)
}

/** Preserve the complete verified session/PAT principal at human adapters. */
export function factoryHumanWorkspaceResponse(user: FactoryUser | null | undefined, work: () => Promise<Response>): Promise<Response> {
  return user ? actAs(user, () => factoryWorkspaceResponse(user.id, work)) : work()
}

/** Profile CRUD and availability keep the same current tenant/principal checks
 * without granting or serializing Project execution. */
export function factoryHumanMembershipResponse(user: FactoryUser | null | undefined, work: () => Promise<Response>): Promise<Response> {
  return user ? actAs(user, () => factoryMembershipResponse(user.id, work)) : work()
}
