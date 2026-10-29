import { createHash } from 'node:crypto'
import { MAX_SKILL_INSTRUCTIONS_LENGTH, runSkillSchema, skillMarkdown, type RunSkill } from '@mikka/protocol/skill'
import { BASELINE_SKILL } from './builtin-skill'
import { ImprovementError } from './contract'
import { SKILL_PATH } from './regression'

const FRONTMATTER = '---\nname: Run report\n---\n\n'
const MAX_MARKDOWN_BYTES = MAX_SKILL_INSTRUCTIONS_LENGTH + Buffer.byteLength(FRONTMATTER) + 1
const SHA = /^[a-f0-9]{40}$/

export function canonicalSkill(markdown: string): RunSkill {
  if (typeof markdown !== 'string' || !markdown.startsWith(FRONTMATTER) ||
    Buffer.byteLength(markdown, 'utf8') > MAX_MARKDOWN_BYTES || markdown.includes('\0') ||
    new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(markdown, 'utf8')) !== markdown)
    throw new ImprovementError('sourceMismatch')
  const body = markdown.slice(FRONTMATTER.length).trim()
  if (Buffer.byteLength(body, 'utf8') > MAX_SKILL_INSTRUCTIONS_LENGTH) throw new ImprovementError('sourceMismatch')
  const parsed = runSkillSchema.safeParse({ ...BASELINE_SKILL, instructions: body, files: [] })
  if (!parsed.success || skillMarkdown(parsed.data) !== markdown) throw new ImprovementError('sourceMismatch')
  return parsed.data
}

/** Only the two public GitHub remote forms; never accept a caller-supplied API URL. */
export function githubRepository(repository: string): string {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(repository)
  if (!match || match[2] === '.' || match[2] === '..') throw new ImprovementError('sourceMismatch')
  return `https://github.com/${match[1]}/${match[2]}`
}

export type SkillSource = { repository: string; sha: string; baseSha: string; path?: string }
export type SkillSourceReader = (source: SkillSource) => Promise<string>

export async function readCommittedSkill(source: SkillSource, fetcher: typeof fetch = fetch): Promise<string> {
  const repository = githubRepository(source.repository)
  if (!SHA.test(source.sha) || !SHA.test(source.baseSha) || source.sha === source.baseSha ||
    (source.path ?? SKILL_PATH) !== SKILL_PATH) throw new ImprovementError('sourceMismatch')
  const api = `https://api.github.com/repos/${repository.slice('https://github.com/'.length)}`
  async function json(path: string, limit = 2_000_000) {
    try {
      const response = await fetcher(`${api}${path}`, { redirect: 'error',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(15_000) })
      if (response.status !== 200 || response.redirected || response.headers.has('location') ||
        response.headers.get('link')?.includes('rel="next"') ||
        Number(response.headers.get('content-length') ?? 0) > limit || !response.body)
        throw new ImprovementError('sourceRequired')
      const reader = response.body.getReader(), chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > limit) throw new ImprovementError('sourceRequired')
          chunks.push(next.value)
        }
      } finally { await reader.cancel() }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
    } catch (error) {
      if (error instanceof ImprovementError) throw error
      // Do not surface fetch errors that can contain URLs or transport credentials.
      throw new ImprovementError('sourceRequired')
    }
  }
  const repo = await json('')
  if (repo.private !== false || repo.full_name?.toLowerCase() !== repository.slice('https://github.com/'.length).toLowerCase())
    throw new ImprovementError('sourceMismatch')
  const compare = await json(`/compare/${source.baseSha}...${source.sha}`)
  if (compare.status !== 'ahead' || compare.behind_by !== 0 || compare.merge_base_commit?.sha !== source.baseSha ||
    !Number.isSafeInteger(compare.total_commits) || compare.total_commits < 1 || compare.total_commits > 250 ||
    !Array.isArray(compare.commits) || compare.commits.length !== compare.total_commits ||
    compare.commits.at(-1)?.sha !== source.sha || !Array.isArray(compare.files) || compare.files.length !== 1 ||
    compare.files[0].filename !== SKILL_PATH || compare.files[0].previous_filename ||
    !['modified', 'added'].includes(compare.files[0].status)) throw new ImprovementError('sourceMismatch')
  const commit = await json(`/git/commits/${source.sha}`)
  if (commit.sha !== source.sha || !SHA.test(commit.tree?.sha)) throw new ImprovementError('sourceMismatch')
  let treeSha = commit.tree.sha
  const segments = SKILL_PATH.split('/')
  let blobSha = ''
  for (const [index, segment] of segments.entries()) {
    const tree = await json(`/git/trees/${treeSha}`)
    if (tree.sha !== treeSha || tree.truncated !== false || !Array.isArray(tree.tree))
      throw new ImprovementError('sourceMismatch')
    const matches = tree.tree.filter((entry: { path?: string }) => entry.path === segment)
    if (matches.length !== 1 || !SHA.test(matches[0].sha)) throw new ImprovementError('sourceMismatch')
    const entry = matches[0]
    if (index < segments.length - 1) {
      if (entry.type !== 'tree' || entry.mode !== '040000') throw new ImprovementError('sourceMismatch')
      treeSha = entry.sha
    } else {
      if (entry.type !== 'blob' || entry.mode !== '100644' || entry.size > MAX_MARKDOWN_BYTES)
        throw new ImprovementError('sourceMismatch')
      blobSha = entry.sha
    }
  }
  if (compare.files[0].sha !== blobSha) throw new ImprovementError('sourceMismatch')
  const blob = await json(`/git/blobs/${blobSha}`, MAX_MARKDOWN_BYTES * 2 + 2000)
  if (blob.sha !== blobSha || blob.encoding !== 'base64' || typeof blob.content !== 'string' ||
    !Number.isSafeInteger(blob.size) || blob.size < 1 || blob.size > MAX_MARKDOWN_BYTES)
    throw new ImprovementError('sourceMismatch')
  const encoded = blob.content.replace(/\n/g, '')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length !== blob.size || bytes.toString('base64') !== encoded ||
    createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== blobSha)
    throw new ImprovementError('sourceMismatch')
  let markdown: string
  try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { throw new ImprovementError('sourceMismatch') }
  if (!Buffer.from(markdown, 'utf8').equals(bytes)) throw new ImprovementError('sourceMismatch')
  canonicalSkill(markdown)
  return markdown
}
