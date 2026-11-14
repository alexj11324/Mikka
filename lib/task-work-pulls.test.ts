import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { FactoryActivityView } from './factory/activity'
import type { IssueThread } from './issue-threads'
import { githubPullRequestKey } from './issue-metadata'
import { taskPullConversations } from './task-work-pulls'

test('published PR sources use the authorized conversation root for continuations and omit inaccessible runs', () => {
  const visible = { id: 'root', detail: { name: 'Visible' }, attempts: [{ runId: 'continued' }] }
  const restricted = { id: 'restricted', detail: null, attempts: [{ runId: 'private' }] }
  const pull = 'https://github.com/Example/Repo/pull/5'
  const other = 'https://github.com/example/repo/pull/6'
  const publication = (url: string, runId: string) => ({ kind: 'pull_request', url, runId })
  const factory = { artifacts: [publication(pull, 'continued'), publication(pull.toLowerCase(), 'private'),
    publication(other, 'restricted'), publication(other, 'missing')] } as unknown as FactoryActivityView
  const sources = taskPullConversations([visible, restricted] as unknown as IssueThread[], factory)
  assert.equal(sources.get(githubPullRequestKey(pull.toLowerCase()))?.id, 'root')
  assert.equal(sources.has(githubPullRequestKey(other)), false)
})
