'use client'

import { useReducedMotion } from 'motion/react'
import { Bar, BarChart, CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts'
import { cn } from '@/lib/utils'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'

type Chart = { labels?: string[]; series?: { name: string; values: number[] }[]; unit?: string }

// Theme chart tokens, mid-tones first so a single series reads on light and dark cards.
const TOKENS = [2, 1, 3, 4, 5]
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function chartData({ labels = [], series = [], unit }: Chart) {
  const config = Object.fromEntries(series.map((item, index) => [`s${index}`, { label: item.name, color: `var(--chart-${TOKENS[index % TOKENS.length]})` }])) satisfies ChartConfig
  const data = labels.map((label, row) => ({ label, ...Object.fromEntries(series.map((item, index) => [`s${index}`, item.values?.[row] ?? null])) }))
  const tick = (value: number) => `${compact.format(value)}${unit ?? ''}`
  const label = series.map(item => item.name).join(', ')
  return { config, data, keys: Object.keys(config), tick, label }
}

/** Bars from the shadcn chart: vertical by default, one row per label when horizontal. */
export function AgentBarChart({ horizontal, ...chart }: Chart & { horizontal?: boolean }) {
  const reduce = useReducedMotion() ?? false
  const { config, data, keys, tick, label } = chartData(chart)
  // Horizontal bars grow with the number of rows, in fixed steps up to 40rem.
  const rows = data.length * (keys.length + 1)
  const height = !horizontal ? 'h-60' : rows <= 6 ? 'h-48' : rows <= 10 ? 'h-64' : rows <= 14 ? 'h-80' : rows <= 18 ? 'h-96' : rows <= 26 ? 'h-128' : 'h-160'
  return <ChartContainer config={config} role="img" aria-label={label} className={cn('aspect-auto w-full min-w-0', height)}>
    <BarChart data={data} layout={horizontal ? 'vertical' : 'horizontal'} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} accessibilityLayer>
      <CartesianGrid vertical={!!horizontal} horizontal={!horizontal} />
      {horizontal ? <>
        <XAxis type="number" tickLine={false} axisLine={false} tickFormatter={tick} />
        <YAxis type="category" dataKey="label" tickLine={false} axisLine={false} width={88} interval={0} />
      </> : <>
        <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={8} />
        <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={tick} />
      </>}
      <ChartTooltip cursor={false} content={<ChartTooltipContent />} />
      {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
      {keys.map(key => <Bar key={key} dataKey={key} fill={`var(--color-${key})`} radius={4} isAnimationActive={!reduce} />)}
    </BarChart>
  </ChartContainer>
}

/** A trend line per series from the shadcn chart. */
export function AgentLineChart(chart: Chart) {
  const reduce = useReducedMotion() ?? false
  const { config, data, keys, tick, label } = chartData(chart)
  return <ChartContainer config={config} role="img" aria-label={label} className="aspect-auto h-60 w-full min-w-0">
    <LineChart data={data} margin={{ left: 0, right: 8, top: 8, bottom: 0 }} accessibilityLayer>
      <CartesianGrid vertical={false} />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={8} />
      <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={tick} />
      <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
      {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
      {keys.map(key => <Line key={key} dataKey={key} type="monotone" stroke={`var(--color-${key})`} strokeWidth={2} dot={false} isAnimationActive={!reduce} />)}
    </LineChart>
  </ChartContainer>
}
