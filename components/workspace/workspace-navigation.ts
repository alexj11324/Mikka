export type WorkspaceSection = 'inbox' | 'my-issues' | 'agent' | 'projects' | 'views' | 'team-home' | 'team-issues' | 'team-projects' | 'all-issues'

export const SECTION_TITLES: Record<WorkspaceSection, string> = {
  inbox: '收件箱', 'my-issues': '我的任务', agent: 'Agent', projects: '项目', views: '视图', 'team-home': '团队主页', 'team-issues': '团队任务', 'team-projects': '团队项目', 'all-issues': '全部任务',
}
