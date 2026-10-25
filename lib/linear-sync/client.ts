import 'server-only'
import { linearGraphQL } from './graphql'
import type { LinearStateOption } from './mapping'

export interface LinearTeamOption {
  id: string
  key: string
  name: string
  states: LinearStateOption[]
}

export interface LinearIssueSnapshot {
  id: string
  identifier: string
  title: string
  description: string | null
  dueDate: string | null
  priority: number
  url: string
  updatedAt: string
  state: { id: string; name: string; type: string } | null
  team: { id: string; key: string; name: string }
  assignee: { id: string; name: string; email: string | null } | null
  labels: { id: string; name: string; color: string | null }[]
}

const CONNECTION_PAGE = 50

export async function linearIdentity(token: string) {
  const data = await linearGraphQL<{ viewer: { id: string; name: string }; organization: { id: string; name: string } }>(token, `query MikkaLinearIdentity { viewer { id name } organization { id name } }`)
  return { user: data.viewer, organization: data.organization }
}

export async function linearTeams(token: string): Promise<LinearTeamOption[]> {
  const result: LinearTeamOption[] = []
  let after: string | null = null
  do {
    type TeamWire = Omit<LinearTeamOption, 'states'> & { states: { nodes: LinearStateOption[] } }
    type TeamPage = { teams: { nodes: TeamWire[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    const data: TeamPage = await linearGraphQL<TeamPage>(token, `query MikkaLinearTeams($first: Int!, $after: String) {
      teams(first: $first, after: $after) {
        nodes { id key name states(first: 50) { nodes { id name type position } } }
        pageInfo { hasNextPage endCursor }
      }
    }`, { first: CONNECTION_PAGE, after })
    result.push(...data.teams.nodes.map(({ states, ...team }) => ({ ...team, states: states.nodes })))
    after = data.teams.pageInfo.hasNextPage ? data.teams.pageInfo.endCursor : null
  } while (after)
  return result
}

export async function linearIssue(token: string, id: string): Promise<LinearIssueSnapshot | null> {
  type IssueWire = Omit<LinearIssueSnapshot, 'labels'> & { labels: { nodes: LinearIssueSnapshot['labels'] } }
  const data = await linearGraphQL<{ issue: IssueWire | null }>(token, `query MikkaLinearIssue($id: String!) {
    issue(id: $id) {
      id identifier title description dueDate priority url updatedAt
      state { id name type }
      team { id key name }
      assignee { id name email }
      labels(first: 50) { nodes { id name color } }
    }
  }`, { id })
  return data.issue ? { ...data.issue, labels: data.issue.labels.nodes } : null
}

export async function findLinearUserByEmail(token: string, email: string) {
  let after: string | null = null
  do {
    type UserPage = { users: { nodes: { id: string; email: string | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    const data: UserPage = await linearGraphQL<UserPage>(token, `query MikkaLinearUsers($first: Int!, $after: String) {
      users(first: $first, after: $after) { nodes { id email } pageInfo { hasNextPage endCursor } }
    }`, { first: CONNECTION_PAGE, after })
    const user = data.users.nodes.find(candidate => candidate.email?.toLowerCase() === email.toLowerCase())
    if (user) return user.id
    after = data.users.pageInfo.hasNextPage ? data.users.pageInfo.endCursor : null
  } while (after)
  return null
}

export async function ensureLinearLabel(token: string, teamId: string, name: string, color: string) {
  let after: string | null = null
  do {
    type LabelsPage = { team: { labels: { nodes: { id: string; name: string }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null } | null }
    const data: LabelsPage = await linearGraphQL<LabelsPage>(token, `query MikkaLinearLabels($id: String!, $first: Int!, $after: String) {
      team(id: $id) { labels(first: $first, after: $after) { nodes { id name } pageInfo { hasNextPage endCursor } } }
    }`, { id: teamId, first: CONNECTION_PAGE, after })
    const labels = data.team?.labels
    const existing = labels?.nodes.find(label => label.name.toLowerCase() === name.toLowerCase())
    if (existing) return existing.id
    after = labels?.pageInfo.hasNextPage ? labels.pageInfo.endCursor : null
  } while (after)

  const created = await linearGraphQL<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } | null } }>(token, `mutation MikkaLinearCreateLabel($input: IssueLabelCreateInput!) {
    issueLabelCreate(input: $input) { success issueLabel { id } }
  }`, { input: { name, color, teamId } })
  if (!created.issueLabelCreate.success || !created.issueLabelCreate.issueLabel) throw new Error(`Linear did not create the label "${name}"`)
  return created.issueLabelCreate.issueLabel.id
}

export interface LinearIssueInput {
  id: string
  teamId: string
  title: string
  description: string
  priority: number
  stateId?: string
  dueDate: string | null
  assigneeId?: string
  labelIds: string[]
}

export async function createLinearIssue(token: string, input: LinearIssueInput) {
  const data = await linearGraphQL<{ issueCreate: { success: boolean; issue: { id: string; identifier: string; updatedAt: string } | null } }>(token, `mutation MikkaLinearCreateIssue($input: IssueCreateInput!) {
    issueCreate(input: $input) { success issue { id identifier updatedAt } }
  }`, { input })
  if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error('Linear did not create the issue')
  return data.issueCreate.issue
}

export type LinearIssuePatch = Omit<LinearIssueInput, 'id' | 'teamId'>
export async function updateLinearIssue(token: string, id: string, input: LinearIssuePatch) {
  const data = await linearGraphQL<{ issueUpdate: { success: boolean; issue: { updatedAt: string } | null } }>(token, `mutation MikkaLinearUpdateIssue($id: String!, $input: IssueUpdateInput!) {
    issueUpdate(id: $id, input: $input) { success issue { updatedAt } }
  }`, { id, input })
  if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error('Linear did not update the issue')
  return data.issueUpdate.issue.updatedAt
}

export async function linearComment(token: string, id: string) {
  const data = await linearGraphQL<{ comment: { id: string; body: string; createdAt: string; parent: { id: string } | null; issue: { id: string } | null; user: { name: string } | null } | null }>(token, `query MikkaLinearComment($id: String!) {
    comment(id: $id) { id body createdAt parent { id } issue { id } user { name } }
  }`, { id })
  return data.comment
}

export async function createLinearComment(token: string, input: { id: string; issueId: string; body: string; parentId?: string }) {
  const data = await linearGraphQL<{ commentCreate: { success: boolean; comment: { id: string } | null } }>(token, `mutation MikkaLinearCreateComment($input: CommentCreateInput!) {
    commentCreate(input: $input) { success comment { id } }
  }`, { input })
  if (!data.commentCreate.success || !data.commentCreate.comment) throw new Error('Linear did not create the comment')
  return data.commentCreate.comment
}

export async function updateLinearComment(token: string, id: string, body: string) {
  const data = await linearGraphQL<{ commentUpdate: { success: boolean } }>(token, `mutation MikkaLinearUpdateComment($id: String!, $input: CommentUpdateInput!) {
    commentUpdate(id: $id, input: $input) { success }
  }`, { id, input: { body } })
  if (!data.commentUpdate.success) throw new Error('Linear did not update the comment')
}
