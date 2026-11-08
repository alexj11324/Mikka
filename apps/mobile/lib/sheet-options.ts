/**
 * 新建 Bot and 新建群聊 as full-height form sheets with the grabber (docs/design/mobile-comma, 06–07).
 *
 * Alex 2026-11-08 on device: 新建群聊 opened with its title, ✕ and ✓ and the keyboard up, but an empty body. The
 * sheet's header is no longer transparent, so the form is laid out below it and needs no inset adjustment, and each
 * sheet's ScrollView is the screen's root view (react-native-screens sizes a form sheet's content from its first
 * child). Pinned by tests/new-sheets.test.mts.
 */
export const newSheetOptions = (background: string) => ({
  presentation: 'formSheet' as const,
  sheetAllowedDetents: [1],
  sheetGrabberVisible: true,
  headerTransparent: false,
  headerShadowVisible: false,
  headerStyle: { backgroundColor: background },
  contentStyle: { backgroundColor: background },
})

/** A review sheet (R3b 「第 N 行」, the pending batch): half height, growing to full for the keyboard (#1738). */
export const reviewSheetOptions = (background: string) => ({ ...newSheetOptions(background), sheetAllowedDetents: [0.6, 1] })
