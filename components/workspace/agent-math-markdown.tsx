'use client'

import type { ComponentProps } from 'react'
import type Markdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import { normalizeMathDelimiters } from '@/lib/math-delimiters'
import { AgentMarkdownContent, type AgentMarkdownProps } from './agent-markdown'
import 'katex/dist/katex.min.css'

const mathRemarkPlugins = [remarkMath]
// KaTeX 的 .katex 字号为 1.21em、字体栈以 serif 结尾，中文会回退成宋体并显得偏大；
// agent-markdown 里给 .cjk_fallback 换回正文字体并按 1/1.21 缩回正文字号。
const rehypePlugins: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']> = [
  [rehypeKatex, { trust: false, strict: 'ignore', throwOnError: false, maxExpand: 1000, maxSize: 20 }],
]

export function AgentMathMarkdown(props: AgentMarkdownProps) {
  return <AgentMarkdownContent {...props} text={normalizeMathDelimiters(props.text)} mathRemarkPlugins={mathRemarkPlugins} rehypePlugins={rehypePlugins} />
}
