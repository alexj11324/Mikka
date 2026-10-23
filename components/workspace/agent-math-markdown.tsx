'use client'

import type { ComponentProps } from 'react'
import type Markdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeMathDelimiters } from '@/lib/math-delimiters'
import { AgentMarkdownContent, type AgentMarkdownProps } from './agent-markdown'
import 'katex/dist/katex.min.css'

const mathRemarkPlugins = [remarkMath]
// KaTeX 的字体栈以 serif 结尾，公式里的中文（.cjk_fallback）在 macOS 上会回退成宋体；agent-markdown 里把它换回正文字体。
const rehypePlugins: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false, maxExpand: 1000, maxSize: 20 }],
]

export function AgentMathMarkdown(props: AgentMarkdownProps) {
  return <AgentMarkdownContent {...props} text={normalizeMathDelimiters(props.text)} mathRemarkPlugins={mathRemarkPlugins} rehypePlugins={rehypePlugins} />
}
