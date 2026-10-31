import assert from 'node:assert/strict'
import test from 'node:test'

import { SKILLS_MAX_PAGE, SKILLS_PAGE_SIZE, skillsPage, skillsSearchResponseSchema, skillsUpstreamUrl } from './skills-search'

test('accepts skills.sh search results', () => {
  const result = skillsSearchResponseSchema.safeParse({
    data: [{
      id: 'vercel-labs/skills/find-skills',
      name: 'Find Skills',
      slug: 'find-skills',
      source: 'vercel-labs/skills',
      installs: 1234,
      url: 'https://skills.sh/vercel-labs/skills/find-skills',
    }],
  })

  assert.equal(result.success, true)
})

test('rejects result links outside skills.sh', () => {
  const result = skillsSearchResponseSchema.safeParse({
    data: [{
      id: 'example/skills/find-skills',
      name: 'Find Skills',
      slug: 'find-skills',
      source: 'example/skills',
      installs: 1,
      url: 'https://example.com/skill',
    }],
  })

  assert.equal(result.success, false)
})

const skill = (n: number) => ({ id: `owner/repo/skill-${n}`, name: `Skill ${n}`, slug: `skill-${n}`, source: 'owner/repo', installs: 1000 - n, url: `https://skills.sh/owner/repo/skill-${n}` })

test('with no query, pages through the all-time leaderboard', () => {
  const first = skillsUpstreamUrl('', 0)
  assert.equal(first.origin + first.pathname, 'https://skills.sh/api/v1/skills')
  assert.equal(first.searchParams.get('view'), 'all-time')
  assert.equal(first.searchParams.get('page'), '0')
  assert.equal(first.searchParams.get('per_page'), String(SKILLS_PAGE_SIZE))
  assert.equal(skillsUpstreamUrl('', 3).searchParams.get('page'), '3')

  const page = Array.from({ length: SKILLS_PAGE_SIZE }, (_, n) => skill(n))
  const parsed = skillsSearchResponseSchema.parse({ data: page, pagination: { page: 0, perPage: SKILLS_PAGE_SIZE, total: 9000, hasMore: true } })
  assert.deepEqual(skillsPage(parsed, '', 0), { data: page, hasMore: true })
  assert.equal(skillsPage({ ...parsed, pagination: { hasMore: false } }, '', 1).hasMore, false)
  assert.equal(skillsPage(parsed, '', SKILLS_MAX_PAGE).hasMore, false)
})

test('a search asks for results up to the end of the page and returns that page', () => {
  const url = skillsUpstreamUrl('react', 1)
  assert.equal(url.pathname, '/api/v1/skills/search')
  assert.equal(url.searchParams.get('q'), 'react')
  assert.equal(url.searchParams.get('limit'), String(2 * SKILLS_PAGE_SIZE))
  assert.equal(skillsUpstreamUrl('react', 9).searchParams.get('limit'), '200')

  const all = Array.from({ length: 2 * SKILLS_PAGE_SIZE }, (_, n) => skill(n))
  const second = skillsPage(skillsSearchResponseSchema.parse({ data: all }), 'react', 1)
  assert.deepEqual(second.data, all.slice(SKILLS_PAGE_SIZE))
  assert.equal(second.hasMore, true)
  // Fewer results than asked for: the search is done.
  assert.equal(skillsPage(skillsSearchResponseSchema.parse({ data: all.slice(0, 70) }), 'react', 1).hasMore, false)
})

test('rejects more results than skills.sh search can return', () => {
  assert.equal(skillsSearchResponseSchema.safeParse({ data: Array.from({ length: 201 }, (_, n) => skill(n)) }).success, false)
})
