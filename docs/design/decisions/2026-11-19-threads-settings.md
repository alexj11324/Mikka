# One Threads destination in Settings

Alex, 2026-11-19. Thread-title controls belong in Settings › Threads, with a
Mine / Workspace selector, so both scopes can be found in one place. The
workspace segment displays the current workspace's name.

## Decision

- Add `threads` to the Settings section registry. Keep the selected workspace
  in its URL and section navigation, including for personal workspaces.
- Move the personal `ThreadTitleSection` from Preferences and the workspace
  `ThreadTitleSection` from General into this destination. Mine remains scoped
  to the person in the selected workspace. Members can read Workspace settings;
  only admins can edit them. Members see disabled controls and a read-only state.
- The official UI owns composition through the existing `settings-preferences`
  slot (`page: 'threads'`, `workspaceId`). Reuse the shipped `SegmentedControl`,
  `ThreadTitleSection`, `useThreadTitleSettings` and the existing read/write
  actions. Both scopes receive the explicit workspace ID and remount when
  the workspace changes.
- Preferences retains its ordinary settings. General retains workspace
  identity, transfer and deletion.

This changes placement only. The title behavior from the
[November 14 title decision](2026-11-14-2330-capy-activity-and-thread-titles.md)
still applies: personal instructions add to workspace instructions, personal
triggers can inherit the workspace default, and manual titles are preserved.
