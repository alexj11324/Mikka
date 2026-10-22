'use client'

import type { ComponentProps } from 'react'
import type Markdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { AgentMarkdownContent, type AgentMarkdownProps } from './agent-markdown'
import 'katex/dist/katex.min.css'

const mathRemarkPlugins = [remarkMath]
const rehypePlugins: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false, maxExpand: 1000, maxSize: 20 }],
]

export function AgentMathMarkdown(props: AgentMarkdownProps) {
  return <AgentMarkdownContent {...props} mathRemarkPlugins={mathRemarkPlugins} rehypePlugins={rehypePlugins} />
}
