'use client'

import { useAgentCopy } from '@/hooks/use-agent-copy'
import { Children, isValidElement, memo, type ComponentProps, type ReactNode } from 'react'
import { AgentCodeBlock } from './agent-code-block'
import dynamic from 'next/dynamic'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'
import { hasMathDelimiters } from '@/lib/math-delimiters'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

const MermaidDiagram = dynamic(() => import('./agent-mermaid').then(module => module.AgentMermaid), {
  ssr: false,
  loading: () => { const agentCopy = useAgentCopy(); return (<p role="status" className="text-sm text-muted-foreground">{agentCopy.loadingDiagram}</p>) },
})

const remarkPlugins = [remarkGfm]
const MathMarkdown = dynamic(() => import('./agent-math-markdown').then(module => module.AgentMathMarkdown))

export type AgentMarkdownProps = {
  text: string
  isStreaming?: boolean
  size?: 'small' | 'default' | 'large' | 'small-heavy' | 'large-heavy'
}

export const AgentMarkdown = memo(function AgentMarkdown(props: AgentMarkdownProps) {
  return hasMathDelimiters(props.text) ? <MathMarkdown {...props} /> : <AgentMarkdownContent {...props} />
})

export function AgentMarkdownContent({ text, isStreaming = false, size = 'default', mathRemarkPlugins = [], rehypePlugins = [] }: AgentMarkdownProps & {
  mathRemarkPlugins?: NonNullable<ComponentProps<typeof Markdown>['remarkPlugins']>
  rehypePlugins?: NonNullable<ComponentProps<typeof Markdown>['rehypePlugins']>
}) {
  const agentCopy = useAgentCopy()

  return <div data-agent-markdown className={cn('agent-markdown flex min-w-0 max-w-full flex-col gap-3 break-words text-sm leading-7 [&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex_.cjk_fallback]:font-sans', {
    'text-xs': size === 'small' || size === 'small-heavy',
    'text-base': size === 'large' || size === 'large-heavy',
    'font-semibold': size === 'small-heavy' || size === 'large-heavy',
  })}>
    <Markdown remarkPlugins={[...remarkPlugins, ...mathRemarkPlugins]} rehypePlugins={rehypePlugins} skipHtml components={{
      h1: ({ node: _node, ...props }) => <h1 {...props} className="mt-3 text-2xl font-semibold leading-snug" />,
      h2: ({ node: _node, ...props }) => <h2 {...props} className="mt-3 text-xl font-semibold leading-snug" />,
      h3: ({ node: _node, ...props }) => <h3 {...props} className="mt-2 text-lg font-semibold leading-snug" />,
      h4: ({ node: _node, ...props }) => <h4 {...props} className="font-semibold" />,
      h5: ({ node: _node, ...props }) => <h5 {...props} className="font-semibold" />,
      h6: ({ node: _node, ...props }) => <h6 {...props} className="font-semibold" />,
      ul: ({ node: _node, ...props }) => <ul {...props} className="flex list-disc flex-col gap-1 ps-6" />,
      ol: ({ node: _node, ...props }) => <ol {...props} className="flex list-decimal flex-col gap-1 ps-6" />,
      blockquote: ({ node: _node, ...props }) => <blockquote {...props} className="rounded-lg bg-muted px-4 py-3 text-muted-foreground" />,
      a: ({ node: _node, href, ...props }) => <a {...props} href={href} className="text-primary underline underline-offset-4" target="_blank" rel="noopener noreferrer" />,
      img: ({ alt }) => <span className="text-muted-foreground">{alt || agentCopy.image}{agentCopy.useTheIllustrationComponentForImages}</span>,
      pre: ({ children }) => {
        const child = Children.toArray(children).find(child => isValidElement<{ className?: string; children?: ReactNode }>(child))
        if (!isValidElement<{ className?: string; children?: ReactNode }>(child)) return null
        const source = String(child.props.children ?? '').replace(/\n$/, '')
        const language = /language-([^\s]+)/.exec(child.props.className ?? '')?.[1] ?? 'text'
        return <div className="agent-code-block">{language.toLowerCase() === 'mermaid'
          ? <MermaidDiagram source={source} isStreaming={isStreaming} />
          : <AgentCodeBlock code={source} language={language} isStreaming={isStreaming} />}</div>
      },
      code: ({ node: _node, ...props }) => <code {...props} className="rounded bg-muted px-1 py-0.5 font-mono text-xs" />,
      table: ({ node: _node, ...props }) => <div tabIndex={0} role="region" aria-label={agentCopy.markdownTable}><Table {...props} /></div>,
      thead: ({ node: _node, ...props }) => <TableHeader {...props} />,
      tbody: ({ node: _node, ...props }) => <TableBody {...props} />,
      tr: ({ node: _node, ...props }) => <TableRow {...props} />,
      th: ({ node: _node, ...props }) => <TableHead {...props} />,
      td: ({ node: _node, ...props }) => <TableCell {...props} />,
      hr: () => <div className="h-3" />,
    }}>{text}</Markdown>
  </div>
}
