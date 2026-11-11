/** One short description for an installed Skill: its YAML front-matter
 * `description`, else its first prose paragraph, bounded for model context. */
export function skillDescription(body: string, fallback: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1]
  const declared = /^description:\s*([^\r\n]+)$/m.exec(frontmatter ?? '')?.[1]?.trim().replace(/^["']|["']$/g, '')
  if (declared) return declared.slice(0, 500)
  const paragraph = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n\r?\n/).map(part => part.trim()).find(part => part && !part.startsWith('#'))
  return (paragraph ?? fallback).slice(0, 500)
}
