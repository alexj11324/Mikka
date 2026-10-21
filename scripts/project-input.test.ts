import assert from 'node:assert/strict'
import { test } from 'node:test'
import { projectInput, projectPatch, hasDependencyCycle, DEFAULT_PROJECT_PROPERTIES } from '../lib/project-input'

const input = { name: '项目验收', summary: '', description: '', status: 'backlog', priority: 'none', lead: '', team: 'Mikka', startDate: '', targetDate: '', properties: DEFAULT_PROJECT_PROPERTIES }
const a = '00000000-0000-4000-8000-000000000001'
const b = '00000000-0000-4000-8000-000000000002'
const c = '00000000-0000-4000-8000-000000000003'
const node = (id: string, dependencyIds: string[]) => ({ id, properties: { dependencyIds } })

test('new projects support no priority and default properties', () => { assert.equal(projectInput.parse(input).priority, 'none'); const { properties: _, ...legacy } = input; assert.deepEqual(projectInput.parse(legacy).properties, DEFAULT_PROJECT_PROPERTIES) })
test('rejects a blank project name', () => assert.equal(projectInput.safeParse({ ...input, name: '  ' }).success, false))
test('trims the project title', () => assert.equal(projectInput.parse({ ...input, name: '  项目  ' }).name, '项目'))
test('rejects invalid statuses, priorities, leads and teams', () => { for (const [key, value] of [['status', 'unknown'], ['priority', 'invalid'], ['lead', 'other-user'], ['team', 'other-team']]) assert.equal(projectInput.safeParse({ ...input, [key]: value }).success, false) })
test('rejects invalid calendar dates', () => assert.equal(projectInput.safeParse({ ...input, startDate: '2026-02-30' }).success, false))
test('rejects target date before start date', () => assert.equal(projectInput.safeParse({ ...input, startDate: '2026-10-25', targetDate: '2026-10-20' }).success, false))
test('allows clearing dates', () => assert.equal(projectInput.safeParse({ ...input, targetDate: '2026-10-25' }).success, true))
test('rejects unauthorized member values', () => assert.equal(projectInput.safeParse({ ...input, properties: { ...DEFAULT_PROJECT_PROPERTIES, members: ['other-user'] } }).success, false))
test('rejects duplicate labels after trimming', () => assert.equal(projectInput.safeParse({ ...input, properties: { ...DEFAULT_PROJECT_PROPERTIES, labels: ['设计', ' 设计 '] } }).success, false))
test('rejects unnamed milestones', () => assert.equal(projectInput.safeParse({ ...input, properties: { ...DEFAULT_PROJECT_PROPERTIES, milestones: [{ id: a, name: '', targetDate: '', completed: false }] } }).success, false))
test('rejects duplicate milestone ids', () => { const milestone = { id: a, name: '交付', targetDate: '', completed: false }; assert.equal(projectInput.safeParse({ ...input, properties: { ...DEFAULT_PROJECT_PROPERTIES, milestones: [milestone, milestone] } }).success, false) })
test('property updates require a valid id and revision', () => { assert.equal(projectPatch.safeParse({ id: a, revision: 1, changes: { status: 'started' } }).success, true); assert.equal(projectPatch.safeParse({ id: a, changes: { status: 'started' } }).success, false) })
test('status-only updates never inject defaults or erase labels and milestones', () => { const patch = projectPatch.parse({ id: a, revision: 1, changes: { status: 'paused' } }); assert.deepEqual(patch.changes, { status: 'paused' }); assert.equal('properties' in patch.changes, false) })
test('rejects empty property updates', () => assert.equal(projectPatch.safeParse({ id: a, revision: 1, changes: {} }).success, false))
test('rejects self dependencies', () => assert.equal(hasDependencyCycle(a, [a], []), true))
test('rejects indirect dependency cycles', () => assert.equal(hasDependencyCycle(a, [b], [node(b, [c]), node(c, [a])]), true))
test('allows shared dependencies without cycles', () => assert.equal(hasDependencyCycle(a, [b, c], [node(b, [c]), node(c, [])]), false))
test('replaces old dependency edges when validating an update', () => assert.equal(hasDependencyCycle(a, [], [node(a, [b]), node(b, [a])]), false))
