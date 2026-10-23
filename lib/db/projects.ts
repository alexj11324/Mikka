import 'server-only'
import { workspaceDb } from '@/lib/workspace-db'

export { projects, projectEvents } from './project-schema'
export const projectDb = workspaceDb
