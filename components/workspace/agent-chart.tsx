'use client'

import { useId } from 'react'
import { useReducedMotion } from 'motion/react'
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Label, Line, LineChart, Pie, PieChart, XAxis, YAxis } from 'recharts'
import { cn } from '@/lib/utils'
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from '@/components/ui/chart'

type Chart = { labels?: string[]; series?: { name: string; values: number[] }[]; unit?: string }

// Series take the theme chart tokens in order, so the first series is --chart-1.
const token = (index: number) => `var(--chart-${index % 5 + 1})`
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

function chartData({ labels = [], series = [], unit }: Chart) {
  const config = Object.fromEntries(series.map((item, index) => [`s${index}`, { label: item.name, color: token(index) }])) satisfies ChartConfig
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

/** ReUI c-chart-14 (stacked area, dashed strokes) with the series passed in; the first series is the solid one on top. */
export function AgentAreaChart(chart: Chart) {
  const reduce = useReducedMotion() ?? false
  const id = useId().replace(/:/g, '')
  const { config, data, keys, tick, label } = chartData(chart)
  return <ChartContainer config={config} role="img" aria-label={label} className="aspect-auto h-60 w-full min-w-0">
    <AreaChart data={data} margin={{ top: 20, right: 0, bottom: 0, left: 0 }} accessibilityLayer>
      <defs>
        {keys.map(key => <linearGradient key={key} id={`${id}-${key}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="5%" stopColor={`var(--color-${key})`} stopOpacity={0.5} />
          <stop offset="95%" stopColor={`var(--color-${key})`} stopOpacity={0.1} />
        </linearGradient>)}
      </defs>
      <CartesianGrid vertical={false} strokeDasharray="3 3" />
      <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} interval="preserveStartEnd" minTickGap={8} />
      <YAxis tickLine={false} axisLine={false} width={44} tickFormatter={tick} />
      <ChartTooltip content={<ChartTooltipContent indicator="dot" className="min-w-40 gap-2.5" />} />
      {keys.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
      {[...keys].reverse().map(key => <Area key={key} dataKey={key} type="natural" stackId="1" fill={`url(#${id}-${key})`} fillOpacity={0.4} stroke={`var(--color-${key})`} strokeWidth={key === keys[0] ? 2 : 0.8} strokeDasharray={key === keys[0] ? undefined : '3 3'} isAnimationActive={!reduce} />)}
    </AreaChart>
  </ChartContainer>
}

type Donut = { slices?: { name: string; value: number }[]; unit?: string; total?: string }

/** ReUI c-chart-19 (donut with the total in the centre) with the slices passed in. */
export function AgentDonutChart({ slices = [], unit, total }: Donut) {
  const reduce = useReducedMotion() ?? false
  const config = Object.fromEntries(slices.map((slice, index) => [`s${index}`, { label: slice.name, color: token(index) }])) satisfies ChartConfig
  const data = slices.map((slice, index) => ({ key: `s${index}`, value: slice.value }))
  const sum = slices.reduce((all, slice) => all + slice.value, 0)
  return <ChartContainer config={config} role="img" aria-label={slices.map(slice => slice.name).join(', ')} className="mx-auto aspect-square max-h-70 w-full min-w-0">
    <PieChart accessibilityLayer>
      <ChartTooltip content={<ChartTooltipContent nameKey="key" className="min-w-40 gap-2.5" />} />
      <Pie data={data} dataKey="value" nameKey="key" innerRadius={65} outerRadius={95} cornerRadius={8} paddingAngle={4} stroke="var(--background)" strokeWidth={4} isAnimationActive={!reduce}>
        {data.map(({ key }) => <Cell key={key} fill={`var(--color-${key})`} />)}
        <Label content={({ viewBox }) => viewBox && 'cx' in viewBox && 'cy' in viewBox ? <text x={viewBox.cx} y={viewBox.cy} textAnchor="middle" dominantBaseline="middle">
          <tspan x={viewBox.cx} y={viewBox.cy} className="fill-foreground text-3xl font-bold tabular-nums">{compact.format(sum)}{unit ?? ''}</tspan>
          {total && <tspan x={viewBox.cx} y={(viewBox.cy || 0) + 22} className="fill-muted-foreground text-xs">{total}</tspan>}
        </text> : null} />
      </Pie>
      <ChartLegend content={<ChartLegendContent nameKey="key" />} />
    </PieChart>
  </ChartContainer>
}
