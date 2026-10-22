import assert from 'node:assert/strict'
import test from 'node:test'

import { skillsSearchResponseSchema } from './skills-search'

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
