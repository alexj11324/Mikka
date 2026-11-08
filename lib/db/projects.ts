import 'server-only'
import { workspaceDb } from '@/lib/workspace-db'

export { projects, projectEvents, projectTasks, projectMembers } from './project-schema'
export const projectDb = workspaceDb
