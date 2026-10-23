import 'server-only'
import { workspaceDb } from '@/lib/workspace-db'
import { requireWorkspace } from '@/lib/workspace-access'
import { createComputerRequestStore } from './store-core'

export const computerRequestStore = createComputerRequestStore(workspaceDb, requireWorkspace)
