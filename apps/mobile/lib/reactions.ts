import type { Reaction } from '@/lib/types'

/** The person's own reaction among a message's, or null. */
export const myReaction = (reactions: readonly Reaction[] | undefined) => reactions?.find(reaction => reaction.mine)?.emoji ?? null

/**
 * A message's reactions once the person's own is `emoji` (null: none), drawn
 * before the server answers: their old one loses a count, the new one gains one.
 */
export function withMine(reactions: readonly Reaction[] | undefined, emoji: string | null): Reaction[] {
  const others = (reactions ?? []).flatMap(reaction => {
    if (!reaction.mine) return [reaction]
    return reaction.count > 1 ? [{ ...reaction, count: reaction.count - 1, mine: false }] : []
  })
  if (!emoji) return others
  const existing = others.find(reaction => reaction.emoji === emoji)
  return existing ? others.map(reaction => reaction === existing ? { ...reaction, count: reaction.count + 1, mine: true } : reaction) : [...others, { emoji, count: 1, mine: true }]
}

/** What tapping a reaction under a message does: removes the person's own, or makes it theirs. */
export const toggled = (reactions: readonly Reaction[] | undefined, emoji: string) => myReaction(reactions) === emoji ? null : emoji
