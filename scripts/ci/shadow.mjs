// Compare the selective closure with the still-running full bootstrap coverage.
// This step has no outputs and cannot change blocking job selection.
import { appendFileSync } from 'node:fs'
import { buildGraph } from './graph.mjs'
import { select } from './select.mjs'
const plan = buildGraph()
const scenarios = {
  mobile: 'apps/mobile/lib/theme.ts', web: 'components/settings/settings-view.tsx',
  daemon: 'packages/daemon/src/index.ts', factory: 'lib/factory/store.ts',
  shared: 'packages/protocol/src/run.ts', migration: 'drizzle/new.sql', docs: 'docs/dev-workflow.md',
}
const rows = []
for (const [name,file] of Object.entries(scenarios)) {
  const result = await select(plan,[{file,status:'M',mode:'100644',oldMode:'100644'}])
  rows.push({scenario:name,file,units:result.units.length,db:result.db_suites.length,daemon:result.daemon,desktop:result.desktop,image:result.image,reasons:result.reasons})
}
const summary = `## Shadow selection vs full coverage\n\nFull baseline: ${Object.values(plan.graph.nodes).filter(n=>n.data.tags.some(t=>['core','integration'].includes(t))).length} unit commands, ${plan.db.scripts.length} DB suites, daemon, Docker and desktop. These are selection counts, not measured timings.\n\n\`\`\`json\n${JSON.stringify(rows,null,2)}\n\`\`\`\n`
console.log(summary)
if(process.env.GITHUB_STEP_SUMMARY)appendFileSync(process.env.GITHUB_STEP_SUMMARY,summary)
