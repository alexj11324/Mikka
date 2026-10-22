import { z } from 'zod'

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
  })).max(12),
})

export type SkillsSearchResult = z.infer<typeof skillsSearchResponseSchema>['data'][number]
