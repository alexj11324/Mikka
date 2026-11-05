import { z } from 'zod'

/** Client-safe references for a task choice; mutable Profile records remain UUID-only. */
export const BUILTIN_AGENT_PROFILE_ID = 'default'
export const agentProfileReferenceSchema = z.union([z.literal(BUILTIN_AGENT_PROFILE_ID), z.uuid()])
