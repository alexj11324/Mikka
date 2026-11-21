import { z } from 'zod'

/** The model and exact funding source the owner selected for a new continuation. */
export const threadModelChoice = z.strictObject({ model: z.string().trim().min(1).max(128),
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('subscription'), connectionId: z.uuid() }),
    z.strictObject({ kind: z.literal('api_key'), keyId: z.uuid() }),
  ]),
})
export type ThreadModelChoice = z.infer<typeof threadModelChoice>
export function choiceFromMenu(id: string): ThreadModelChoice | null {
  try {
    const [model, kind, key] = JSON.parse(id)
    const choice = threadModelChoice.safeParse({ model, source: kind === 'subscription' ? { kind, connectionId: key } : { kind, keyId: key } })
    return choice.success ? choice.data : null
  } catch { return null }
}
export function threadModelKey(choice: ThreadModelChoice) {
  return JSON.stringify([choice.model, choice.source.kind,
    choice.source.kind === 'subscription' ? choice.source.connectionId : choice.source.keyId])
}
