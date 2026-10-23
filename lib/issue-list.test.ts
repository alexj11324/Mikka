import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mergeIssueRows } from './issue-list'

const at = (id: string, updatedAt: string) => ({ id, updatedAt: new Date(updatedAt) })

test('merged issue lists keep one row per id and the newest page', () => {
  const merged = mergeIssueRows([
    [at('owned-new', '2026-10-03T00:00:00Z'), at('shared', '2026-10-02T00:00:00Z')],
    [at('shared', '2026-10-01T00:00:00Z'), at('member-old', '2026-10-01T00:00:00Z')],
    [at('public', '2026-10-04T00:00:00Z')],
  ], 3)
  assert.deepEqual(merged.map(row => row.id), ['public', 'owned-new', 'shared'])
})

test('list index migrations are idempotent and cover the list filters', () => {
  const issueSql = readFileSync(new URL('../drizzle/20261023040000_issue_list_indexes.sql', import.meta.url), 'utf8')
  const workspaceSql = readFileSync(new URL('../drizzle/20261023040001_workspace_list_indexes.sql', import.meta.url), 'utf8')
  assert.match(workspaceSql, /^--\s*target:\s*DATABASE_URL/m)
  const statements = `${issueSql}\n${workspaceSql}`.split(';').map(part => part.split('\n').filter(line => line.trim() && !line.trim().startsWith('--')).join('\n').trim()).filter(Boolean)
  for (const statement of statements) assert.match(statement, /^create index if not exists/i)
  for (const name of ['issues_owner_updated_idx', 'issue_members_member_idx', 'workspace_projects_owner_updated_idx', 'mikka_workspace_members_user_active_idx', 'orvilo_team_issues_team_idx']) {
    assert.match(`${issueSql}\n${workspaceSql}`, new RegExp(name))
  }
})
