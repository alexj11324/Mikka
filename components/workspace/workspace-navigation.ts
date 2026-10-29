export type WorkspaceSection = 'inbox' | 'my-issues' | 'agent' | 'coordinator' | 'projects' | 'views' | 'team-home' | 'team-issues' | 'team-projects' | 'all-issues' | 'plugins' | 'suggestions' | 'artifacts'

export const SECTION_TITLE_KEYS: Record<WorkspaceSection, string> = {
  inbox: 'Nav.inbox',
  'my-issues': 'Nav.myTasks',
  agent: 'Nav.agent',
  coordinator: 'Nav.coordinator',
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
