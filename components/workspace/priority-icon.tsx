import { cn } from '@/lib/utils'

/** Linear-style priority mark, 14px (Figma 看板/优先级): 紧急 is a filled square with !, the rest three bars. Board cards and the list share it (R-25). */
const PRIORITY_BARS: Record<string, number> = { high: 3, normal: 2, low: 1 }

export function PriorityIcon({ priority, label }: { priority: string; label?: string }) {
  const a11y = label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true as const }
  if (priority === 'urgent') return <svg {...a11y} viewBox="0 0 14 14" className="size-3.5 shrink-0 text-warning"><rect width="14" height="14" rx="3" fill="currentColor" /><path d="M7 3.5v4.25" stroke="var(--card)" strokeWidth="1.75" strokeLinecap="round" /><circle cx="7" cy="10.25" r="1" fill="var(--card)" /></svg>
  const filled = PRIORITY_BARS[priority] ?? 0
  return <svg {...a11y} viewBox="0 0 14 14" className="size-3.5 shrink-0">{[[1, 5], [5.5, 8], [10, 11]].map(([x, height], index) => <rect key={x} x={x} y={12.5 - height} width="3" height={height} rx="1" className={cn(index < filled ? 'fill-muted-foreground' : 'fill-foreground/15')} />)}</svg>
}
