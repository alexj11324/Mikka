// R-42: every visible string lives in messages/. The mobile app was written before
// the check covered it, so this file freezes how many hardcoded Chinese strings each
// file still holds. The list only shrinks: migrate a string, lower its number; a file
// at 0 leaves the list. A new file, or one more string in a frozen file, fails the
// check — a whole-file freeze would let new strings in unnoticed.
//
// Regenerate only after migrating (never to admit new strings): run
// `node scripts/check-i18n.mjs`; it names each frozen file whose count no longer matches
// the tree, and each migrated file to drop.
const BASELINE = {
  'apps/mobile/app/(tabs)/settings/index.tsx': 13,
  'apps/mobile/app/(tabs)/settings/memory-summary.tsx': 8,
  'apps/mobile/app/(tabs)/settings/memory.tsx': 4,
  'apps/mobile/app/(tabs)/settings/profile.tsx': 9,
  'apps/mobile/app/(tabs)/settings/workspace.tsx': 1,
  'apps/mobile/app/attach.tsx': 6,
  'apps/mobile/app/bots/[id]/info.tsx': 29,
  'apps/mobile/app/bots/[id]/tasks.tsx': 1,
  'apps/mobile/app/groups/[id].tsx': 12,
  'apps/mobile/app/message-text.tsx': 1,
  'apps/mobile/app/message.tsx': 4,
  'apps/mobile/app/new-bot.tsx': 12,
  'apps/mobile/components/AttachMenu.tsx': 1,
  'apps/mobile/components/ChatFiles.tsx': 2,
  'apps/mobile/components/ChatScrollToLatest.tsx': 1,
  'apps/mobile/components/FailedReply.tsx': 3,
  'apps/mobile/components/Markdown.tsx': 3,
  'apps/mobile/components/MessageMenu.ios.tsx': 4,
  'apps/mobile/components/MessageMenu.tsx': 1,
  'apps/mobile/components/ModelNotice.tsx': 5,
  'apps/mobile/components/OfflineBanner.tsx': 1,
  'apps/mobile/components/OpenUI.tsx': 20,
  'apps/mobile/components/StartupGate.tsx': 5,
  'apps/mobile/components/ThreadPlace.ios.tsx': 2,
  'apps/mobile/components/ThreadPlace.tsx': 2,
  'apps/mobile/components/ThreadQuotaPaused.tsx': 9,
  'apps/mobile/components/chat.tsx': 7,
  'apps/mobile/components/icons.tsx': 2,
  'apps/mobile/components/ui.tsx': 1,
  'apps/mobile/features/chat/components/chat-attachment-card.tsx': 4,
  'apps/mobile/features/chat/components/chat-image-viewer.tsx': 9,
  'apps/mobile/features/chat/components/chat-images.tsx': 5,
  'apps/mobile/features/chat/components/chat-queue-card.tsx': 9,
  'apps/mobile/features/chat/components/chat-selectable-text.tsx': 1,
  'apps/mobile/features/chat/components/chat-selection-bar.tsx': 1,
  'apps/mobile/features/chat/components/chat-title-pill.tsx': 1,
  'apps/mobile/features/chat/model/chat-queue.ts': 1,
  'apps/mobile/features/chat/model/chat-selection.ts': 11,
  'apps/mobile/features/chat/screens/chat-screen.tsx': 9,
  'apps/mobile/features/home/components/chat-badge.tsx': 3,
  'apps/mobile/features/home/components/chat-menu.tsx': 8,
  'apps/mobile/features/home/components/section-header.tsx': 1,
  'apps/mobile/features/plugins/use-plugin-connections.ts': 2,
  'apps/mobile/features/review/components/review-bar.tsx': 6,
  'apps/mobile/features/review/components/review-summary-row.tsx': 2,
  'apps/mobile/features/review/components/use-review.ts': 7,
  'apps/mobile/features/review/model/review.ts': 25,
  'apps/mobile/features/review/screens/batch-sheet.tsx': 6,
  'apps/mobile/features/review/screens/comment-sheet.tsx': 7,
  'apps/mobile/features/review/screens/file-screen.tsx': 11,
  'apps/mobile/features/review/screens/note-sheet.tsx': 4,
  'apps/mobile/features/review/screens/review-screen.tsx': 17,
  'apps/mobile/features/search/screens/search-screen.tsx': 4,
  'apps/mobile/features/workspace/screens/workspaces-screen.tsx': 8,
  'apps/mobile/lib/chat-line.ts': 1,
  'apps/mobile/lib/chat-time.ts': 9,
  'apps/mobile/lib/clock.ts': 2,
  'apps/mobile/lib/model-choice.ts': 5,
  'apps/mobile/lib/model-menu-view.ts': 6,
  'apps/mobile/lib/run-info.ts': 2,
  'apps/mobile/lib/thread-icon.ts': 5,
  'apps/mobile/lib/thread-send-error.ts': 7,
  'apps/mobile/lib/waiting.ts': 3,
  'apps/mobile/lib/workspace-switch.ts': 2,
}

/** How many hardcoded strings each frozen file is allowed to keep, by repository-relative path. */
export function frozenMobileFiles() {
  return new Map(Object.entries(BASELINE))
}
