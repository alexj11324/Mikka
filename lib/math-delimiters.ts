// 模型常输出 LaTeX 风格的 \( \) 与 \[ \]，remark-math 只认 $ / $$，且 Markdown 会把 \( 当作转义吃掉反斜杠。
// 渲染前统一换成 $ 定界符；代码块、行内代码与已有的 $$ 公式保持原样。
const MATH_TOKENS = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|\$\$[\s\S]*?\$\$)|(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]|(?<!\\)\\\(([\s\S]+?)(?<!\\)\\\)/g

export function hasMathDelimiters(text: string) {
  return text.includes('$') || text.includes('\\(') || text.includes('\\[')
}

export function normalizeMathDelimiters(text: string) {
  if (!text.includes('\\(') && !text.includes('\\[')) return text
  return text.replace(MATH_TOKENS, (match: string, kept: string | undefined, display: string | undefined, inline: string | undefined, offset: number) => {
    if (kept !== undefined) return kept
    if (inline !== undefined) return `$${inline.trim()}$`
    const body = display!.trim()
    const indent = text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset)
    // 行内出现的 \[ \] 留在行内，避免打断段落或列表；独占一行时才输出块级公式。
    if (indent.trim()) return `$$\\displaystyle ${body}$$`
    const next = text[offset + match.length]
    return `$$\n${body.split('\n').map(line => indent + line.trim()).join('\n')}\n${indent}$$${next && next !== '\n' ? '\n' : ''}`
  })
}
