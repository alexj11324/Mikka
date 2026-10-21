'use client'

import { lazy, Suspense } from 'react'
import type { SyntaxHighlighterProps } from 'react-syntax-highlighter'

const PrismHighlighter = lazy(() => import('react-syntax-highlighter/dist/esm/prism'))

export function Prism(props: SyntaxHighlighterProps) {
  return <Suspense fallback={<pre className="openui-code-block-syntax-highlighter"><code>{props.children}</code></pre>}>
    <PrismHighlighter {...props} />
  </Suspense>
}
