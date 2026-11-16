/** Use the installed Markdown Skill name rules for file discovery too. */
export function skillName(body: string, fallback: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? ''
  return /^name:\s*([^\r\n]+)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '') || fallback
}

/** A lightweight directory exposes only an explicitly declared description. */
export function declaredSkillDescription(body: string) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body)?.[1] ?? ''
  return /^description:[ \t]*([^\r\n]*)$/m.exec(frontmatter)?.[1]?.trim().replace(/^["']|["']$/g, '').slice(0, 500) ?? ''
}

/** One short description for an installed Skill: its YAML front-matter
 * `description`, else its first prose paragraph, bounded for model context. */
export function skillDescription(body: string, fallback: string) {
  const declared = declaredSkillDescription(body)
  if (declared) return declared
  const paragraph = body.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').split(/\r?\n\r?\n/).map(part => part.trim()).find(part => part && !part.startsWith('#'))
  return (paragraph ?? fallback).slice(0, 500)
}
