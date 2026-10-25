const TEXT_NAME = /\.(?:txt|md|markdown|csv|tsv|json|ya?ml|toml|xml|html?|css|log|[cm]?[jt]sx?|py|go|rs|java|rb|sh|sql)$/i

/** What the file picker offers: plain-text files the conversation can read. */
export const TEXT_ATTACHMENT_ACCEPT = 'text/*,.md,.markdown,.csv,.tsv,.json,.yaml,.yml,.toml,.xml,.log,.js,.jsx,.ts,.tsx,.mjs,.cjs,.py,.go,.rs,.java,.rb,.sh,.sql'

/**
 * Conversations take text only, so an attachment travels as its contents in a
 * fenced block under its name. Anything else, or anything over `maxChars`, is refused.
 */
export async function textAttachment(file: File, maxChars: number): Promise<string | null> {
  if (!file.type.startsWith('text/') && !TEXT_NAME.test(file.name)) return null
  const text = await file.text()
  const block = `${file.name}\n\`\`\`\n${text.replace(/\n$/, '')}\n\`\`\``
  return block.length > maxChars ? null : block
}
