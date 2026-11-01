import { createHash } from 'node:crypto'
import { z } from 'zod'
import { abortable } from '@/lib/search/url-policy'
import { installSkillSchema, PluginError, type SkillContent } from './contracts'

async function boundedText(response: Response, signal: AbortSignal, max: number) {
  if (!response.ok || !response.body) throw new PluginError('skillSourceUnavailable', 502)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const part = await abortable(() => reader.read(), signal)
      if (part.done) return Buffer.concat(chunks).toString('utf8')
      bytes += part.value.byteLength
      if (bytes > max) throw new PluginError('skillSourceTooLarge', 422)
      chunks.push(part.value)
    }
  } finally { void reader.cancel().catch(() => {}) }
}

/** Install Markdown only from a fixed GitHub commit. Never runs a package manager,
 * repository hooks or scripts, and never follows URLs supplied in SKILL.md. */
export async function fetchSkillSource(input: z.infer<typeof installSkillSchema>, fetchImpl: typeof fetch = fetch): Promise<SkillContent> {
  const { source, slug } = installSkillSchema.parse(input)
  const signal = AbortSignal.timeout(15_000)
  const get = async (url: string, max: number) => boundedText(await fetchImpl(url, { redirect: 'error', credentials: 'omit', cache: 'no-store', signal, headers: { Accept: 'application/vnd.github+json' } }), signal, max)
  try {
    const commit = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(await get(`https://api.github.com/repos/${source}/commits/HEAD`, 200_000)))
    const tree = z.object({ truncated: z.literal(false), tree: z.array(z.object({ path: z.string(), type: z.string(), mode: z.string().optional(), size: z.number().optional() })) }).parse(JSON.parse(await get(`https://api.github.com/repos/${source}/git/trees/${commit.sha}?recursive=1`, 2_000_000)))
    const candidates = tree.tree.filter(item => item.type === 'blob' && item.mode !== '120000' && (item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md')) && item.size !== undefined && item.size <= 20_000)
    if (candidates.length > 200) throw new PluginError('skillSourceTooLarge', 422)
    const matches: { path: string; body: string; name: string }[] = []
    // The public skill id is its frontmatter name, which need not be the
    // directory name (vercel-react-best-practices lives in react-best-practices).
    // Read pinned Markdown with bounded concurrency; reject duplicate names.
    for (let start = 0; start < candidates.length; start += 6) {
      const batch = await Promise.all(candidates.slice(start, start + 6).map(async item => {
        const path = item.path
        if (path.split('/').some(part => part === '..' || part === '.')) throw new PluginError('invalidSkillSource', 422)
        const body = await get(`https://raw.githubusercontent.com/${source}/${commit.sha}/${path.split('/').map(encodeURIComponent).join('/')}`, 20_000)
        if (!body.trim() || body.includes('\0')) return null
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? ''
        const name = /^name:\s*([^\r\n]+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '')
          || path.split('/').at(-2) || source.split('/')[1]
        return name.toLowerCase() === slug.toLowerCase() ? { path, body, name } : null
      }))
      matches.push(...batch.filter((match): match is NonNullable<typeof match> => match !== null))
    }
    if (matches.length !== 1) throw new PluginError('skillSourceAmbiguousOrMissing', 422)
    const { path, body, name } = matches[0]
    return { name, source: source.toLowerCase(), slug, sourceKind: 'skills.sh', sourceRevision: commit.sha, sourcePath: path, body, sha256: createHash('sha256').update(body).digest('hex') }
  } catch (error) {
    if (error instanceof PluginError) throw error
    throw new PluginError('skillSourceUnavailable', 502)
  }
}
