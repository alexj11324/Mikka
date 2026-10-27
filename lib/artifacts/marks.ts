// Marks quoted text inside a rendered Markdown artifact: text already quoted
// in a message stays underlined, the text being quoted right now keeps a
// tint. A remark plugin, so React renders the marks like any other node and
// nothing touches the DOM afterwards. Matching ignores whitespace, since a
// selection across lines or blocks comes back with breaks the source lacks.

export type MarkKind = 'quoted' | 'quoting'
export interface TextMark { text: string; kind: MarkKind }

type MdastNode = { type: string; value?: string; children?: MdastNode[]; data?: Record<string, unknown> }

export function remarkMarks(marks: readonly TextMark[]) {
  return (tree: MdastNode) => {
    const wanted = marks.map(mark => ({ ...mark, needle: mark.text.replace(/\s+/g, '') })).filter(mark => mark.needle)
    if (!wanted.length) return
    // Every text node in order, and where its non-space characters start in the joined string.
    const texts: { node: MdastNode; parent: MdastNode; offsets: number[] }[] = []
    let joined = ''
    const collect = (node: MdastNode) => {
      for (const child of node.children ?? []) {
        if (child.type === 'text' && child.value) {
          const offsets: number[] = []
          for (let index = 0; index < child.value.length; index++) {
            if (/\s/.test(child.value[index])) continue
            offsets.push(index)
            joined += child.value[index]
          }
          texts.push({ node: child, parent: node, offsets })
        } else if (child.type !== 'code' && child.type !== 'inlineCode') collect(child)
      }
    }
    collect(tree)
    // Which characters of each text node fall in a mark, first hit of each mark only.
    const kinds = new Map<MdastNode, (MarkKind | null)[]>()
    for (const mark of wanted) {
      const at = joined.indexOf(mark.needle)
      if (at < 0) continue
      let position = 0
      for (const { node, offsets } of texts) {
        const value = node.value ?? ''
        const from = Math.max(at - position, 0)
        const to = Math.min(at + mark.needle.length - position, offsets.length)
        if (from < to) {
          const row = kinds.get(node) ?? Array.from<MarkKind | null>({ length: value.length }).fill(null)
          // Spaces between two marked characters belong to the mark too.
          for (let index = offsets[from]; index <= offsets[to - 1]; index++) row[index] = row[index] === 'quoting' ? 'quoting' : mark.kind
          kinds.set(node, row)
        }
        position += offsets.length
      }
    }
    for (const { node, parent } of texts) {
      const row = kinds.get(node)
      if (!row || !parent.children) continue
      const value = node.value ?? ''
      const pieces: MdastNode[] = []
      let start = 0
      for (let index = 1; index <= value.length; index++) {
        if (index < value.length && row[index] === row[start]) continue
        const text = value.slice(start, index)
        const kind = row[start]
        pieces.push(kind ? { type: 'textMark', data: { hName: 'span', hProperties: { dataMark: kind } }, children: [{ type: 'text', value: text }] } : { type: 'text', value: text })
        start = index
      }
      parent.children.splice(parent.children.indexOf(node), 1, ...pieces)
    }
  }
}
