import { z } from 'zod'

/** Skills per page of the 技能 tab. */
export const SKILLS_PAGE_SIZE = 50
/** skills.sh search returns at most this many results and has no pages. */
export const SKILLS_SEARCH_MAX = 200
/** The all-time leaderboard serves 100,000 rows. */
export const SKILLS_MAX_PAGE = 100_000 / SKILLS_PAGE_SIZE - 1

export const skillsSearchResponseSchema = z.object({
  data: z.array(z.object({
    id: z.string().min(1).max(500),
    name: z.string().min(1).max(200),
    slug: z.string().min(1).max(200),
    source: z.string().min(1).max(200),
    installs: z.number().int().nonnegative(),
    url: z.string().url().refine(value => {
      try {
        const url = new URL(value)
        return url.protocol === 'https:' && ['skills.sh', 'www.skills.sh'].includes(url.hostname)
      } catch {
        return false
      }
    }),
  })).max(SKILLS_SEARCH_MAX),
  // The leaderboard's own paging; search has none.
  pagination: z.object({ hasMore: z.boolean() }).optional(),
})

export type SkillsSearchResult = z.infer<typeof skillsSearchResponseSchema>['data'][number]

/**
 * The skills.sh request for one page: with no query, the all-time leaderboard
 * (skills.sh's own default order, by installs) through its page/per_page; a
 * search has no pages, so it asks for everything up to the end of this page.
 */
export function skillsUpstreamUrl(query: string, page: number) {
  const url = new URL(query ? '/api/v1/skills/search' : '/api/v1/skills', 'https://skills.sh')
  if (query) {
    url.searchParams.set('q', query)
    url.searchParams.set('limit', String(Math.min(SKILLS_SEARCH_MAX, (page + 1) * SKILLS_PAGE_SIZE)))
  } else {
    url.searchParams.set('view', 'all-time')
    url.searchParams.set('page', String(page))
    url.searchParams.set('per_page', String(SKILLS_PAGE_SIZE))
  }
  return url
}

/** This page's skills and whether another page follows. */
export function skillsPage(result: z.infer<typeof skillsSearchResponseSchema>, query: string, page: number): { data: SkillsSearchResult[]; hasMore: boolean } {
  if (!query) return { data: result.data, hasMore: Boolean(result.pagination?.hasMore) && page < SKILLS_MAX_PAGE }
  const end = (page + 1) * SKILLS_PAGE_SIZE
  return { data: result.data.slice(page * SKILLS_PAGE_SIZE, end), hasMore: result.data.length >= end && end < SKILLS_SEARCH_MAX }
}
