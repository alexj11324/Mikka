import 'server-only'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { createComputerPolicy } from './policy-core'

export const { workspaceComputerAccess, setWorkspaceComputerAccess } = createComputerPolicy(workspaceDb, requireWorkspace)
