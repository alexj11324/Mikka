'use client'

import { CodeBlock } from '@/components/agents/code-block'
import type { AgentCodeLanguage } from '@/components/agents/agent-code'

const languages: Record<string, AgentCodeLanguage> = {
  bash: 'bash', sh: 'bash', shell: 'bash', diff: 'diff', json: 'json', text: 'text', plaintext: 'text',
  tsx: 'tsx', jsx: 'tsx', ts: 'typescript', typescript: 'typescript', js: 'javascript', javascript: 'javascript',
  py: 'python', python: 'python', css: 'css', html: 'html', sql: 'sql', yml: 'yaml', yaml: 'yaml', md: 'markdown', markdown: 'markdown',
}

export function AgentCodeBlock({ code, language = 'text', filename, isStreaming = false, highlightLines }: {
  code: string; language?: string; filename?: string; isStreaming?: boolean; highlightLines?: number[]
}) {
  const supportedLanguage = Object.hasOwn(languages, language.toLowerCase()) ? languages[language.toLowerCase()] : 'text'
  return <CodeBlock code={code} language={supportedLanguage} filename={filename} status={isStreaming ? 'streaming' : 'complete'} highlightLines={highlightLines} maxHeight={420} />
}
