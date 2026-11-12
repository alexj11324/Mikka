import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { desktopRunUpdate } from '../lib/platform/desktop-notifications'
import { readLocation, workspaceHref } from '../components/workspace/workspace-navigation'

const taskId = '10000000-0000-4000-8000-000000000001'
const runId = '30000000-0000-4000-8000-000000000001'
const teamId = '40000000-0000-4000-8000-000000000001'
const origin = 'https://mikka.example/mikka'

/** Check JSX wiring even when pages use different layouts. A secondary editor
 * or a handler that replaces the selected id cannot satisfy this contract. */
function elements(file: string) {
  const source = ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const result: ts.JsxAttributes[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) result.push(node.attributes)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return (component: string, prop: string) => result.flatMap(attrs => {
    const parent = attrs.parent
    if ((!ts.isJsxOpeningElement(parent) && !ts.isJsxSelfClosingElement(parent)) || parent.tagName.getText(source) !== component) return []
    return attrs.properties.flatMap(attr => ts.isJsxAttribute(attr) && attr.name.getText(source) === prop && attr.initializer && ts.isJsxExpression(attr.initializer) && attr.initializer.expression
      ? [attr.initializer.expression.getText(source).replace(/\s+/g, '')] : [])
  })
}

test('workspace Task entry points forward their UUID to the shared TaskDetail selection', () => {
  const prop = elements('../components/workspace/issue-workspace.tsx')
  for (const [component, name] of [['BoardPage', 'onOpen'], ['IssueList', 'onOpen'], ['ProjectWorkspace', 'onOpenIssue']]) {
    assert.deepEqual(prop(component, name), ['openFromList'], component)
  }
  assert.deepEqual(prop('TeamHome', 'onIssues'), ["()=>navigate('all')"])
  assert.deepEqual(prop('GlobalSearch', 'onIssue'), ['open'])
  for (const page of ['TasksPage', 'InboxPage']) assert.deepEqual(prop(page, 'onOpenIssue'), ['id=>{open(id)}'], page)
  assert.deepEqual(prop('TaskDetail', 'id'), ['selected'])
  assert.deepEqual(prop('EmbeddedTaskDetail', 'issueId'), ['taskShown'])
  const embedded = elements('../components/coordinator/conversation-panels.tsx')
  assert.deepEqual(embedded('TaskDetail', 'id'), ['issueId'])
})

test('Board, Project, Team, Search, Tasks, Inbox and system notifications resolve the same Task after a reload', () => {
  for (const query of ['section=all-issues', 'section=projects', `section=team-issues&team=${teamId}`, 'section=coordinator', 'section=tasks', 'section=suggestions']) {
    const href = workspaceHref(new URL(`${origin}?${query}`), { issue: taskId })
    const reopened = readLocation(new URL(href, origin).searchParams)
    assert.equal(reopened.issue, taskId, query)
    assert.equal(reopened.thread, null, query)
  }
  const run = { issueId: taskId, runId, issueTitle: 'Task', agentName: 'Agent', status: 'failed' as const }
  const [notification] = desktopRunUpdate(new Map([[taskId, 'running']]), [run]).notifications
  const reopened = readLocation(new URL(notification.href, origin).searchParams)
  assert.equal(reopened.issue, taskId)
  assert.equal(reopened.thread, runId, 'a notification retains the historical run it belongs to')
  assert.equal(readLocation(new URL(`${origin}?section=coordinator&task=${taskId}`).searchParams).task, taskId)
})
