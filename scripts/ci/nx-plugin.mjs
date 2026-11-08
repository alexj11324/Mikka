import { buildGraph } from './graph.mjs'
export const name = 'mikka-explicit-ci'
let plan
export const createNodesV2 = ['nx.json', async (_files, _options, context) => {
  plan = buildGraph(context.workspaceRoot)
  return [['nx.json', { projects: Object.fromEntries(Object.values(plan.graph.nodes).map(n => [n.data.root, n.data])) }]]
}]
export const createDependencies = (_options, context) => Object.values((plan ?? buildGraph(context.workspaceRoot)).graph.dependencies).flat()
