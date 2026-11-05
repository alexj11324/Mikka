import type { PoolClient } from 'pg'
import type { RoutingMember } from './group-routing'
import { AGENT_TOOL_IDS } from '@/lib/agent-kit/registry'

type PublicBot = { id:string; name:string; publicRole:string; ownerId:string; repository:string|null; tools:unknown; skills:unknown }
const executionTools = new Set(['dispatch_run','dispatch_factory_run','dispatch_factory_task','dispatch_bot_computer','intake_factory_request'])

/** This projection is the privacy boundary: never SELECT the full definition,
 * instructions, skill bodies, account IDs or provider configuration. */
export async function groupBotCatalog(client: Pick<PoolClient,'query'>, actorId:string, workspaceId:string, ids:string[], availability:(bot:Pick<PublicBot,'id'|'ownerId'|'repository'>)=>Promise<{available:boolean;reason?:string}>, ownerActive:(ownerId:string)=>Promise<boolean>): Promise<RoutingMember[]> {
  if (!ids.length) return []
  const { rows } = await client.query<PublicBot>(`SELECT b.id,b.name,b."publicRole",b."ownerId",b.repository,
    v.definition->'tools' AS tools,
    (SELECT jsonb_agg(jsonb_build_object('name',s->>'name','description',s->>'description')) FROM jsonb_array_elements(COALESCE(v.definition->'skills','[]'::jsonb)) s) AS skills
    FROM bots b LEFT JOIN agent_kit_heads h ON h.owner_id=b."ownerId" AND h.bot_id=b.id AND h.workspace_id=b."workspaceId"
    LEFT JOIN agent_kit_versions v ON v.id=h.active_version AND v.owner_id=h.owner_id AND v.bot_key=h.bot_key
    WHERE b."workspaceId"=$1 AND b.id=ANY($2::uuid[]) AND b."ownerId" IS NOT NULL AND b."archivedAt" IS NULL`,[workspaceId,ids])
  const result:RoutingMember[]=[]
  for (const id of ids) {
    const row=rows.find(row=>row.id===id)
    if (!row || !await ownerActive(row.ownerId)) continue
    const tools=Array.isArray(row.tools) ? row.tools.filter((tool):tool is typeof AGENT_TOOL_IDS[number]=>typeof tool==='string' && (AGENT_TOOL_IDS as readonly string[]).includes(tool)) : []
    const skills=Array.isArray(row.skills) ? row.skills.filter((skill):skill is {name:string;description:string}=>Boolean(skill && typeof skill.name==='string' && typeof skill.description==='string')).slice(0,20) : []
    // An unconfigured bot uses the registered built-in task capability. An
    // explicit definition that removed dispatch remains unable to dispatch.
    const configured= row.tools == null || tools.some(tool=>executionTools.has(tool))
    const execution=configured ? await availability({id:row.id,ownerId:row.ownerId,repository:row.repository}) : undefined
    const canExecute=configured && execution?.available === true
    // Direct chat does not expose a tool executor. Configured tools are not
    // falsely advertised as usable in this group merely because they exist.
    const capabilityNames=[...(row.ownerId===actorId?['answer']:[]),...(configured?['factory_task','task_status']:[])]
    result.push({id:row.id,name:row.name,memberType:'bot',role:row.publicRole || null,
      description: [row.publicRole,...skills.map(skill=>`${skill.name}: ${skill.description}`)].filter(Boolean).join('\n').slice(0,2000) || 'No public role or skill description is configured.',
      capabilities:capabilityNames, executionAvailable:canExecute,
      chatAvailable:row.ownerId===actorId,
      executionReason:!configured ? 'task_tool_disabled' : !canExecute ? execution?.reason ?? 'execution_unavailable' : execution?.reason==='quota_check_required' ? execution.reason : undefined,
    })
  }
  return result
}
