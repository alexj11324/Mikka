declare const sanitizedMermaidSvg: unique symbol
export type SanitizedMermaidSvg = string & { readonly [sanitizedMermaidSvg]: true }

let renderQueue: Promise<unknown> = Promise.resolve()
let renderSequence = 0

export function renderAgentMermaid(id: string, source: string, theme: 'dark' | 'default'): Promise<SanitizedMermaidSvg> {
  if (source.length > 20000 || /%%\s*\{|^\s*---/.test(source)) {
    return Promise.reject(new Error('图表过大或包含不允许的配置。'))
  }
  // Mermaid configuration is global; serialize configuration and rendering across replies.
  const result = renderQueue.catch(() => undefined).then(async () => {
    const [{ renderBeautifulAgentMermaid, supportsBeautifulMermaid }, { default: DOMPurify }] = await Promise.all([import('./agent-beautiful-mermaid'), import('dompurify')])
    const sanitize = (svg: string) => DOMPurify.sanitize(svg, {
      USE_PROFILES: { svg: true, svgFilters: true },
      FORBID_TAGS: ['foreignObject', 'script', 'iframe', 'image', 'a', 'use', 'animate', 'set', 'animateTransform'],
      FORBID_ATTR: ['href', 'xlink:href'],
    }) as SanitizedMermaidSvg
    if (supportsBeautifulMermaid(source)) {
      try {
        return sanitize(renderBeautifulAgentMermaid(`${id}${++renderSequence}`, source))
      } catch {
        // Valid Mermaid syntax not supported by the preferred renderer still uses strict Mermaid.
      }
    }
    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme,
      htmlLabels: false,
      flowchart: { htmlLabels: false },
      maxTextSize: 20000,
      maxEdges: 200,
      suppressErrorRendering: true,
      secure: ['securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'htmlLabels', 'theme'],
    })
    const renderId = `agentmermaid${id}${++renderSequence}`
    try {
      const { svg } = await mermaid.render(renderId, source)
      return sanitize(svg)
    } finally {
      document.getElementById(`d${renderId}`)?.remove()
    }
  })
  renderQueue = result
  return result
}
