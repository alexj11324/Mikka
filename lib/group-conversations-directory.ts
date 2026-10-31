import { z } from 'zod'
import type { Directory } from './group-conversations-store'
type Sources = {
  activeUsers(workspaceId: string, ids: string[]): Promise<string[]>
  ownedAgents(userId: string, ids: string[]): Promise<string[]>
  ownedBots?(workspaceId: string, userId: string, ids: string[]): Promise<string[]>
}
/** Explicit least privilege boundary: workspace membership never shares private agents. */
export function groupDirectory(sources: Sources): Directory {
  return async (workspaceId, userId, members) => {
    const users = [...new Set([userId, ...members.filter(m => m.memberType === 'user').map(m => m.memberId)])]
    const active = new Set(await sources.activeUsers(workspaceId, users))
    if (users.some(id => !active.has(id))) return false
    const ids = [...new Set(members.filter(m => m.memberType === 'agent').map(m => m.memberId))]
    if (ids.some(id => !z.uuid().safeParse(id).success)) return false
    if (ids.length) {
      const own = new Set(await sources.ownedAgents(userId, ids))
      if (ids.some(id => !own.has(id))) return false
    }
    const bots = [...new Set(members.filter(m => m.memberType === 'bot').map(m => m.memberId))]
    if (bots.some(id => !z.uuid().safeParse(id).success)) return false
    if (bots.length) {
      if (!sources.ownedBots) return false
      const own = new Set(await sources.ownedBots(workspaceId, userId, bots))
      if (bots.some(id => !own.has(id))) return false
    }
    return true
  }
}
