import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import messages from '../../messages/en.json'
import { DEFAULT_PROJECT_PROPERTIES } from '@/lib/project-input'
import type { Project, ProjectControlField } from './project-properties'
import { ProjectTextEditor } from './project-text-editor'
import { ProjectPropertyControl, projectDirectory } from './project-property-controls'

const workspaceId = 'b19ab4a3-abd7-46e2-9260-8d41d63c208d'
const projectId = 'c71fa6e8-241d-45e1-bd43-89e2a674791c'
const people = [
  { userId: 'owner', name: 'Morgan', email: 'owner@example.invalid', status: 'active' as const },
  { userId: 'peer', name: 'Jordan', email: 'peer@example.invalid', status: 'active' as const },
  { userId: 'former', name: 'Reed', email: 'former@example.invalid', status: 'suspended' as const },
]
function control(field: ProjectControlField, value: { memberIds?: string[]; leadUserId?: string | null; canEditProperties: boolean; archivedAt?: Project['archivedAt'] }, directoryWorkspace = workspaceId, plain = false) {
  const markup = renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
    <ProjectPropertyControl field={field} projectId={projectId} plain={plain} directory={projectDirectory({ workspace: { id: directoryWorkspace }, members: people })}
      value={{ workspaceId, userId: 'owner', status: 'planned', priority: 'normal', lead: 'me', startDate: '', targetDate: '',
        properties: { ...DEFAULT_PROJECT_PROPERTIES, members: ['me'] }, ...value }} onChange={() => {}} />
  </NextIntlClientProvider>)
  return markup
}

test('the Project property controls show canonical people, including a different lead and each member', () => {
  const value = { memberIds: ['owner', 'peer'], leadUserId: 'peer', canEditProperties: true }
  assert.match(control('lead', value), /Lead: Jordan/)
  assert.match(control('members', value), /Morgan and Jordan/)
  assert.doesNotMatch(control('members', value), /<button[^>]*\sdisabled=""/)
  assert.match(control('members', { ...value, canEditProperties: false }), /<button[^>]*\sdisabled=""/)
  assert.match(control('members', { ...value, memberIds: ['former'] }), /Reed \(suspended\)/)
  assert.match(control('members', { ...value, memberIds: ['missing'] }), /Former member/)
})

test('all Project property controls stay read-only when archived and become editable on restore', () => {
  const fields: ProjectControlField[] = ['status', 'health', 'priority', 'lead', 'members', 'startDate', 'targetDate', 'labels', 'dependencyIds']
  const disabledButton = /<button[^>]*\sdisabled=""/
  for (const field of fields) {
    for (const plain of [false, true]) {
      const archived = { canEditProperties: true, archivedAt: new Date('2026-01-01') }
      assert.match(control(field, archived, workspaceId, plain), disabledButton, field)
      assert.doesNotMatch(control(field, { ...archived, archivedAt: null }, workspaceId, plain), disabledButton, field)
      assert.match(control(field, { canEditProperties: false, archivedAt: null }, workspaceId, plain), disabledButton, field)
    }
  }
})

test('legacy me is resolved against the stored creator and names never cross workspace directories', () => {
  assert.match(control('lead', { canEditProperties: true }), /Lead: Morgan/)
  assert.match(control('members', { canEditProperties: true }), /Morgan/)
  const wrongWorkspace = control('members', { memberIds: ['owner'], canEditProperties: true }, 'another-workspace')
  assert.doesNotMatch(wrongWorkspace, /Morgan/)
  assert.match(wrongWorkspace, /<button[^>]*\sdisabled=""/)
})

test('read-only Project text never mounts a writable heading or rich-text toolbar', () => {
  function render(field: 'name' | 'description', readOnly: boolean, value = 'Office inventory') {
    return renderToStaticMarkup(<NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <ProjectTextEditor field={field} readOnly={readOnly} value={value} onSave={async () => false} onRegisterFlush={() => {}} />
    </NextIntlClientProvider>)
  }
  assert.match(render('name', false), /contentEditable="plaintext-only"/i)
  assert.match(render('name', true), /<h1[^>]*>Office inventory<\/h1>/)
  const longTitle = 'A'.repeat(170) + '项目归档后显示完整'
  const heading = render('name', true, longTitle)
  assert.ok(heading.includes('>' + longTitle + '</h1>'))
  assert.match(heading, /class="[^"]*\bmax-w-full\b/)
  assert.match(heading, /class="[^"]*\bwrap-anywhere\b/)
  assert.doesNotMatch(heading, /contentEditable|role="textbox"/i)
  assert.doesNotMatch(render('description', true), /role="toolbar"|contentEditable="true"/i)
})
