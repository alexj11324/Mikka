import { Schema, type AttributeSpec, type MarkSpec, type NodeSpec } from '@tiptap/pm/model'
import { readIssueContent } from './issue-document-seed'
import spec from './issue-editor-schema-spec.json'

type Attrs = Record<string, { default?: unknown; validate?: string }>
type SerializedSpec = { topNode: string; nodes: [string, Record<string, unknown>][]; marks: [string, Record<string, unknown>][] }

function attrs(source: { [name: string]: AttributeSpec } | undefined): Attrs | undefined {
  if (!source) return undefined
  return Object.fromEntries(Object.entries(source).map(([name, value]) => [name, {
    ...('default' in value ? { default: value.default ?? null } : {}),
    ...(typeof value.validate === 'string' ? { validate: value.validate } : {}),
  }]))
}
const pick = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))

/** The parts of a schema that nodeFromJSON().check() uses, without DOM/React hooks. */
export function issueEditorSchemaSpec(schema: Schema): SerializedSpec {
  const nodes: SerializedSpec['nodes'] = []
  schema.spec.nodes.forEach((name, node: NodeSpec) => { nodes.push([name, pick({ content: node.content, marks: node.marks, group: node.group, inline: node.inline, atom: node.atom, attrs: attrs(node.attrs) })]) })
  const marks: SerializedSpec['marks'] = []
  schema.spec.marks.forEach((name, mark: MarkSpec) => { marks.push([name, pick({ attrs: attrs(mark.attrs), excludes: mark.excludes, inclusive: mark.inclusive, group: mark.group, spanning: mark.spanning })]) })
  return { topNode: schema.spec.topNode ?? 'doc', nodes, marks }
}

let schema: Schema | undefined
/** Server-side issue editor schema (same validation rules as the editor, no React node views). */
export function serverIssueSchema() {
  const serialized = spec as SerializedSpec
  return schema ??= new Schema({ topNode: serialized.topNode, nodes: Object.fromEntries(serialized.nodes) as Record<string, NodeSpec>, marks: Object.fromEntries(serialized.marks) as Record<string, MarkSpec> })
}
export function readableIssueContentOnServer(content: unknown, issueId?: string) {
  return readIssueContent(serverIssueSchema(), content, issueId)
}
