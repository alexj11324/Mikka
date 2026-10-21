import 'server-only'
import { workspaceDb } from '@/lib/workspace-db'
export { projects, projectEvents } from './project-schema'
// Existing issues use ORVILO_DATABASE_URL; new project tables live in the connected Neon resource.
export const projectDb = workspaceDb
