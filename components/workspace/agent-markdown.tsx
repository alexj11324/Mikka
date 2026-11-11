'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { Children, createContext, isValidElement, memo, use, useMemo, type ComponentProps, type ReactNode } from 'react'
import { AgentCodeBlock } from './agent-code-block'
import dynamic from 'next/dynamic'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { remarkCitations } from '@/lib/coordinator/citations'
import { CitationAnchor, useAgentCitations } from './agent-citations'
import { hasMathDelimiters } from '@/lib/math-delimiters'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const MermaidDiagram = dynamic(() => import('./agent-mermaid').then(module => module.AgentMermaid), {
  ssr: false,
  loading: () => { const agentCopy = useAgentCopy(); return (<p role="status" className="text-sm text-muted-foreground">{agentCopy.loadingDiagram}</p>) },
})

const remarkPlugins = [remarkGfm]
const NO_PLUGINS: [] = []
const MathMarkdown = dynamic(() => import('./agent-math-markdown').then(module => module.AgentMathMarkdown))

export type AgentMarkdownProps = {
  text: string
  isStreaming?: boolean
  size?: 'small' | 'default' | 'large' | 'small-heavy' | 'large-heavy'
}

export const AgentMarkdown = memo(function AgentMarkdown(props: AgentMarkdownProps) {
  return hasMathDelimiters(props.text) ? <MathMarkdown {...props} /> : <AgentMarkdownContent {...props} />
})

/** Whether the reply is still arriving, for the code and diagram blocks inside it. */
const MarkdownStreaming = createContext(false)

function MarkdownImage({ alt }: { alt?: string }) {
  const agentCopy = useAgentCopy()
  return <span className="text-muted-foreground">{alt || agentCopy.image}{agentCopy.useTheIllustrationComponentForImages}</span>
}

function MarkdownTable({ node: _node, ...props }: ComponentProps<'table'> & { node?: unknown }) {
  const agentCopy = useAgentCopy()
  return <div tabIndex={0} role="region" aria-label={agentCopy.markdownTable}><Table {...props} /></div>
}

function MarkdownPre({ children }: { children?: ReactNode }) {
  const isStreaming = use(MarkdownStreaming)
  const child = Children.toArray(children).find(child => isValidElement<{ className?: string; children?: ReactNode }>(child))
  if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
  const source = String(child.props.children ?? '').replace(/\n$/, '')
  const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? 'text'
  return <div className="agent-code-block">{language.toLowerCase() === 'mermaid'
    ? <MermaidDiagram source={source} isStreaming={isStreaming} />
    : <AgentCodeBlock code={source} language={language} isStreaming={isStreaming} />}</div>
}

/**
 * Defined once: react-markdown uses these as element types, so a new function per render would remount every
 * paragraph, chip and code block on each streamed token, replaying their enter animations (the chat flashed).
 */
const components: NonNullable<ComponentProps<typeof Markdown>['components']> = {
  // Chat type (R-32): a reply is 13/21 (14 in the hosted thread), so its headings stay close to it, Comma's quiet way –
  // the top two one step up (text-md 15/24), the rest the body size in SemiBold. Document sizes (24, 20, 18) shouted here.
  h1: ({ node: _node, ...props }) => <h1 {...props} className="mt-2 text-md font-semibold" />,
  h2: ({ node: _node, ...props }) => <h2 {...props} className="mt-2 text-md font-semibold" />,
  h3: ({ node: _node, ...props }) => <h3 {...props} className="mt-1 font-semibold" />,
  h4: ({ node: _node, ...props }) => <h4 {...props} className="font-semibold" />,
  h5: ({ node: _node, ...props }) => <h5 {...props} className="font-semibold" />,
  h6: ({ node: _node, ...props }) => <h6 {...props} className="font-semibold" />,
  ul: ({ node: _node, ...props }) => <ul {...props} className="flex list-disc flex-col gap-1 ps-6" />,
  ol: ({ node: _node, ...props }) => <ol {...props} className="flex list-decimal flex-col gap-1 ps-6" />,
  blockquote: ({ node: _node, ...props }) => <blockquote {...props} className="rounded-lg bg-muted px-4 py-3 text-muted-foreground" />,
  a: ({ node: _node, ...props }) => <CitationAnchor {...props} />,
  img: MarkdownImage,
  pre: MarkdownPre,
  code: ({ node: _node, ...props }) => <code {...props} className="rounded bg-muted px-1 py-0.5 font-mono text-sm" />,
  table: MarkdownTable,
  thead: ({ node: _node, ...props }) => <TableHeader {...props} />,
  tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
  tr: ({ node: _node, ...props }) => <TableRow {...props} />,
  th: ({ node: _node, ...props }) => <TableHead {...props} />,
  td: ({ node: _node, ...props }) => <TableCell {...props} />,
  hr: () => <div className="h-3" />,
}

export function AgentMarkdownContent({ text, isStreaming = false, size = 'default', mathRemarkPlugins = NO_PLUGINS, rehypePlugins = NO_PLUGINS }: AgentMarkdownProps & {
  mathRemarkPlugins?: NonNullable<ComponentProps<typeof Markdown>['remarkPlugins']>
  rehypePlugins?: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']>
}) {
  const cites = Boolean(useAgentCitations())
  const plugins = useMemo(() => [...remarkPlugins, ...mathRemarkPlugins, ...(cites ? [remarkCitations] : [])], [mathRemarkPlugins, cites])

  return <div data-agent-markdown data-size={size} className={cn('agent-markdown flex min-w-0 max-w-full flex-col gap-3 break-words text-sm leading-5.25 [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex_.cjk_fallback]:font-sans', {
    'text-xs': size === 'small' || size === 'small-heavy',
    'text-base': size === 'large' || size === 'large-heavy',
    'font-semibold': size === 'small-heavy' || size === 'large-heavy',
  })}>
    <MarkdownStreaming value={isStreaming}>
      <Markdown remarkPlugins={plugins} rehypePlugins={rehypePlugins} skipHtml components={components}>{text}</Markdown>
    </MarkdownStreaming>
  </div>
}
