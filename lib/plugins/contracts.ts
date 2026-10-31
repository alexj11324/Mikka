import { z } from 'zod'
import { webUrlSchema } from '@/lib/search/url-schema'

export class PluginError extends Error {
  constructor(readonly code: string, readonly status = 503) { super(code) }
}

// User-provided MCP servers receive only their explicitly saved credential.
// Never accept transport, forwarding, cookie or hop-by-hop headers as auth.
export const mcpAuthSchema = z.object({
  name: z.string().regex(/^(?:authorization|x-api-key|api-key|x-auth-token)$/i),
  value: z.string().min(1).max(4096).refine(value => !/[\r\n\0]/.test(value)),
}).strict()
export const createMcpSchema = z.object({
  name: z.string().trim().min(1).max(80), url: webUrlSchema.refine(value => { const url = new URL(value); return !url.search && !url.hash }, 'Use the auth field for credentials'),
  transport: z.enum(['http', 'sse']).default('http'),
  enabled: z.boolean().default(true), auth: mcpAuthSchema.optional(),
}).strict()
export const updateMcpSchema = z.object({
  id: z.uuid(), name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(),
  // A URL change requires a new connection, preventing credentials following another host.
  auth: mcpAuthSchema.nullable().optional(),
}).strict().refine(value => value.name !== undefined || value.enabled !== undefined || value.auth !== undefined)
export const deletePluginSchema = z.object({ id: z.uuid() }).strict()
export const installSkillSchema = z.object({
  source: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_.-]{1,100}$/),
  slug: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/),
}).strict()
export const updateSkillSchema = z.object({ id: z.uuid(), enabled: z.boolean() }).strict()
export type McpServerView = {
  id: string; name: string; url: string; transport: 'http' | 'sse'; enabled: boolean;
  revision: number; authKind: 'header' | 'none'; createdAt: string;
}
export type InstalledSkill = {
  id: string; name: string; source: string; slug: string; sourceKind: 'skills.sh' | 'built-in' | 'self-improvement';
  sourceRevision: string; sourcePath: string; sha256: string; enabled: boolean; createdAt: string;
}
export type SkillContent = Pick<InstalledSkill, 'name' | 'source' | 'slug' | 'sourceKind' | 'sourceRevision' | 'sourcePath' | 'sha256'> & { body: string }
export type PersonalPluginSnapshot = {
  servers: Pick<McpServerView, 'id' | 'name' | 'revision'>[];
  skills: (SkillContent & { id: string })[];
  toolkits?: string[];
}
export const PERSONAL_MCP_TOOLS = ['list_personal_mcp_tools', 'call_personal_mcp_tool'] as const
