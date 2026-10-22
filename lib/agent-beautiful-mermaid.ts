import { parseMermaid, renderMermaidSVG } from 'beautiful-mermaid'

export function supportsBeautifulMermaid(source: string): boolean {
  const withoutComments = source.replace(/^\s*%%[^\n]*(?:\n|$)/gm, '').trimStart()
  return /^(?:(?:flowchart|graph)\s|stateDiagram(?:-v2)?\b|sequenceDiagram\b|classDiagram\b|erDiagram\b|xychart(?:-beta)?\b)/.test(withoutComments)
}

const semanticClasses = [
  'classDef focus fill:var(--diagram-focus-fill),stroke:var(--label-blue),stroke-width:1.5px,color:var(--foreground)',
  'classDef success fill:var(--diagram-success-fill),stroke:var(--success),color:var(--foreground)',
  'classDef warning fill:var(--diagram-warning-fill),stroke:var(--warning),color:var(--foreground)',
].join('\n')

export function renderBeautifulAgentMermaid(id: string, source: string): string {
  if (source.length > 20000 || /%%\s*\{|^\s*---/.test(source) || source.split('\n').length > 400) {
    throw new Error('图表过大或包含不允许的配置。')
  }
  if (/^\s*(?:classDef|style|linkStyle)\s.*(?:url\s*\(|@import|expression\s*\(|javascript:|\\)/im.test(source)) {
    throw new Error('图表样式包含不允许的资源。')
  }
  const isFlowchart = /^(?:flowchart|graph)\s/m.test(source.trimStart())
  if (isFlowchart || /^stateDiagram/m.test(source.trimStart())) {
    const graph = parseMermaid(source)
    if (graph.nodes.size > 200 || graph.edges.length > 200) throw new Error('图表节点或连线过多。')
  }
  const svg = renderMermaidSVG(isFlowchart ? `${source}\n${semanticClasses}` : source, {
    bg: 'var(--card)', fg: 'var(--foreground)',
    accent: 'var(--label-blue)', muted: 'var(--muted-foreground)',
    line: 'var(--diagram-line)', surface: 'var(--diagram-surface)', border: 'var(--diagram-border)',
    font: 'system-ui', padding: 24, nodeSpacing: 36, layerSpacing: 56, transparent: true,
  })
  const prefix = `agentbeautiful${id.replace(/[^a-zA-Z0-9]/g, '')}`
  // The renderer emits document-global CSS and shared marker IDs; isolate each reply and keep fonts local.
  return svg.replace(/<svg\b/, `<svg id="${prefix}"`)
    .replace(/\sid="([^"]+)"/g, (attribute, value: string) => value === prefix ? attribute : ` id="${prefix}-${value}"`)
    .replace(/url\(#([^)]+)\)/g, `url(#${prefix}-$1)`)
    .replace(/<style>([\s\S]*?)<\/style>/g, (_, css: string) => {
      const scoped = css.replace(/@import\s+url\([^)]*\)\s*;/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/([^{}]+)\{/g, (_, selectors: string) => `${selectors.trim().split(',').map(selector => {
          const trimmed = selector.trim()
          return trimmed === 'svg' ? `#${prefix}` : `#${prefix} ${trimmed}`
        }).join(', ')} {`)
      return `<style>${scoped}</style>`
    })
}
