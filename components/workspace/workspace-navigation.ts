export type WorkspaceSection = 'inbox' | 'my-issues' | 'agent' | 'coordinator' | 'group' | 'projects' | 'views' | 'team-home' | 'team-issues' | 'team-projects' | 'all-issues' | 'plugins' | 'suggestions' | 'artifacts'

export const SECTION_TITLE_KEYS: Record<WorkspaceSection, string> = {
  inbox: 'Nav.inbox',
  'my-issues': 'Nav.myTasks',
  agent: 'Nav.agent',
  coordinator: 'Nav.coordinator',
  group: 'GroupChat.untitled',
  projects: 'Nav.projects',
  views: 'Nav.views',
  'team-home': 'Nav.teamHome',
  'team-issues': 'Nav.tasks',
  'team-projects': 'Nav.projects',
  'all-issues': 'Nav.allIssues',
  plugins: 'Nav.plugins',
  suggestions: 'Nav.suggestions',
  artifacts: 'Nav.artifacts',
}

/** Sections a reload or a shared link reopens; the others start from their parent page. */
const URL_SECTIONS = ['agent', 'coordinator', 'plugins', 'suggestions', 'artifacts', 'all-issues'] as const satisfies readonly WorkspaceSection[]

export function sectionFromQuery(section: string | undefined): WorkspaceSection {
  // Older links open the projects page by name too.
  return [...URL_SECTIONS, 'projects' as const].find(item => item === section) ?? 'coordinator'
}

export function writeSectionQuery(params: URLSearchParams, section: WorkspaceSection): void {
  if (URL_SECTIONS.some(item => item === section)) params.set('section', section)
  else params.delete('section')
}
