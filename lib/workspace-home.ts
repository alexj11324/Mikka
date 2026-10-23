import 'server-only'
import { listIssues } from '@/app/actions/issues'
import { listProjects } from '@/app/actions/projects'
import { listTeams } from '@/app/actions/teams'

function warn(label: string, error: unknown) {
  console.error(label, error instanceof Error ? error.name : 'error')
}

/** One request loads the project home. React cache() dedupes the session and workspace lookup inside it. */
export async function loadWorkspaceHome() {
  const [issues, projects, teams] = await Promise.all([
    listIssues().catch(error => { warn('Failed to list issues', error); return undefined }),
    listProjects().catch(error => { warn('Failed to list projects', error); return undefined }),
    listTeams().catch(error => { warn('Failed to list teams', error); return undefined }),
  ])
  return { issues, projects, teams }
}
