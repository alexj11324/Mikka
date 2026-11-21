'use client'

import { useTranslations } from '@/lib/intl/i18n-client'
import { useMemo } from 'react'
import { ansiToLines, CodeBlock as TerminalCode, CodeBlockContent as TerminalContent } from '@/components/reui/code-block/code-block'
import { CodeBlock, CodeBlockContent, CodeBlockFooter, CodeBlockHeader, CodeBlockTitle } from '@/components/ui/code-block'
import { cn } from '@/lib/utils'

const TERMINAL_CODE = '[--code-block-padding:0px] [--code-block-font-size:0.75rem] [--code-block-line-height:1.25rem] [&_[data-slot=code-block-line-content]]:[overflow-wrap:anywhere]'

export function ThreadToolDetails({ command, input, output, exitCode }: {
  command?: string
  input?: string
  output?: string
  exitCode?: number
}) {
  const t = useTranslations('Coordinator.activity.card')
  const outputLines = useMemo(() => command && output ? ansiToLines(output.replace(/\r?\n$/, '')) : undefined, [command, output])

  if (command) return <CodeBlock size="sm" className="border-border bg-card" data-thread-tool-details="" data-thread-terminal="">
    <div dir="ltr" className="flex max-h-72 min-w-0 flex-col gap-1 overflow-auto overscroll-contain px-2.5 py-2 text-left scrollbar-thin" data-thread-terminal-scroll="">
      <div className="flex min-w-0 shrink-0 items-start gap-2">
        <span aria-hidden="true" className="shrink-0 font-mono text-xs leading-5 text-muted-foreground select-none">$</span>
        <TerminalCode code={command} language="bash" label={t('command')} wrap variant="ghost" data-thread-command="" className={cn(TERMINAL_CODE, 'flex-1 text-foreground')}>
          <TerminalContent />
        </TerminalCode>
      </div>
      {outputLines && <TerminalCode lines={outputLines} label={t('result')} wrap variant="ghost" data-thread-tool-output="" className={cn(TERMINAL_CODE, 'shrink-0 text-muted-foreground')}>
        <TerminalContent />
      </TerminalCode>}
    </div>
    {exitCode !== undefined && <CodeBlockFooter className={cn('pb-2 tabular-nums', exitCode !== 0 && 'text-destructive-foreground')}>
      {t('exitCode', { code: exitCode })}
    </CodeBlockFooter>}
  </CodeBlock>

  return <CodeBlock size="sm" data-thread-tool-details="">
    {input && <>
      <CodeBlockHeader><CodeBlockTitle>{t('args')}</CodeBlockTitle></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-40">{input}</CodeBlockContent>
    </>}
    {output && <>
      <CodeBlockHeader><CodeBlockTitle>{t('result')}</CodeBlockTitle></CodeBlockHeader>
      <CodeBlockContent wrap className="max-h-64" data-thread-tool-output="">{output}</CodeBlockContent>
    </>}
    {exitCode !== undefined && <CodeBlockFooter className="tabular-nums">{t('exitCode', { code: exitCode })}</CodeBlockFooter>}
  </CodeBlock>
}
