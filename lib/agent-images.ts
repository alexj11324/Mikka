import { z } from 'zod'

export const agentImageQuery = z.string().trim().min(2).max(160).refine(value => !/[\r\n<>]/.test(value) && !/https?:\/\//i.test(value))

export type AgentImageResult = {
  src: string
  width: number
  height: number
  title: string
  source: string
  author: string
  license: string
}

const metadataValue = z.object({ value: z.string().or(z.number()) }).optional()
const commonsResponse = z.object({
  query: z.object({ pages: z.record(z.string(), z.object({
    title: z.string(),
    index: z.number().optional(),
    imageinfo: z.array(z.object({
      thumburl: z.string().optional(),
      thumbwidth: z.number().int().positive().max(30000).optional(),
      thumbheight: z.number().int().positive().max(30000).optional(),
      descriptionurl: z.string(),
      mime: z.string(),
      extmetadata: z.object({ Artist: metadataValue, LicenseShortName: metadataValue }).optional(),
    })).optional(),
  })) }).optional(),
})

function plainText(value: string | number | undefined) {
  return String(value ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim().slice(0, 300)
}

export function parseAgentImage(data: unknown): AgentImageResult | null {
  const parsed = commonsResponse.safeParse(data)
  if (!parsed.success) return null
  const pages = Object.values(parsed.data.query?.pages ?? {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  for (const page of pages) {
    const image = page.imageinfo?.[0]
    if (!image?.thumburl || !image.thumbwidth || !image.thumbheight || !/^image\/(jpeg|png|webp)$/.test(image.mime)) continue
    try {
      const src = new URL(image.thumburl)
      const source = new URL(image.descriptionurl)
      if (src.protocol !== 'https:' || !['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(src.hostname) || src.username || src.password) continue
      if (source.protocol !== 'https:' || source.hostname !== 'commons.wikimedia.org' || source.username || source.password) continue
      const license = plainText(image.extmetadata?.LicenseShortName?.value)
      if (!license) continue
      return { src: src.toString(), width: image.thumbwidth, height: image.thumbheight, title: page.title.replace(/^File:/, ''), source: source.toString(), author: plainText(image.extmetadata?.Artist?.value), license }
    } catch {
      continue
    }
  }
  return null
}

export async function findAgentImage(query: string, signal?: AbortSignal) {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  url.search = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${agentImageQuery.parse(query)} filetype:bitmap`,
    gsrnamespace: '6', gsrlimit: '3', prop: 'imageinfo', iiprop: 'url|mime|extmetadata',
    iiextmetadatafilter: 'Artist|LicenseShortName', iiurlwidth: '960',
  }).toString()
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Orvilo-UI-Agent/1.0 (Wikimedia Commons image lookup)' },
    next: { revalidate: 86400 },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error('图片来源暂时不可用，请稍后重试。')
  return parseAgentImage(await response.json())
}
