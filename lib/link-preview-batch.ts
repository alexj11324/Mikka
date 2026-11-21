// Client-safe half of batched link previews. The action module app/actions/*
// is replaced at build time by a virtual module that emits only its exported
// async functions, so a constant exported from there is not importable by the
// renderer. The web and desktop both read the limit from this module instead.

/** At most this many links per round trip, so a long thread cannot become one
 * slow action (the batching shape lib/message-reactions.ts uses). */
export const LINK_PREVIEWS_PER_REQUEST = 50

/** One URL is accepted only at this length; longer text is not a link we fetch. */
export const LINK_PREVIEW_MAX_URL_LENGTH = 2000
