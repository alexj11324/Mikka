# Desktop workbench interaction review

Reference: Capy Desktop 0.9.2 packaged renderer and screenshots. Mikka checkouts:
public `ccd7e6c66` and hosted `3aeb5cd`, with the local changes under review.
The checks use an official renderer build and isolated browser fixtures. A
production account, macOS native window behavior and connected services were
outside the test environment.

| Journey | Finding | Change and evidence |
| --- | --- | --- |
| Hover a task description, insert or reorder a block | The two floating controls sat outside the editor with a gap. The pointer left the editor and cleared the target before the buttons received a click. | Bridge the gap and let diagonal pointer movement reach the controls. The same stepwise Chromium pointer path failed on the old build and opened the block picker after the change. The grip opens its action menu, a native drag reorders blocks, and the editor publishes the changed document. |
| Edit an existing or read-only description | The pencil could appear while the editor was unavailable. Legacy descriptions had a second disclosure inside the task description. Document tools could hide the rest of the task. | Pass the document's actual editability and coordinate the task disclosure with the editor, and render the same supporting sections in both editor modes. The insert menu uses the app locale, including searchable labels. |
| Find a related thread or a tool | The work area's plus opened an intermediate empty tab. | The plus opens a search picker using the active chat's related items and available workspace tools. Existing tabs are reused and an empty tab is still available in the picker. |
| Read and switch tabs | The chat slot supplied short labels, but the final renderer kept only the full title. Deleting a task could leave an active empty tab. | Forward the short label and preserve the full accessible title. Prune removed task pages from the open-tab state and select a neighbor. |
| Use a narrow window, keyboard or touch | The page-level Escape handler could fold the work area after the editor consumed Escape. Some row actions depended on hover. | Respect a consumed Escape and offer usable touch targets for row actions. |
| Read a thread in the work area | Nested padding and card edges made it look disconnected from the task view. Existing rows replayed their entry animation and the top fade ran at the start of the transcript. | Use the shell's flat layout in the workbench. Give the run pane a shared reading and composer inset, show saved messages at full opacity, and apply the fade only when scrolled. |

Capy's renderer supports multiple simultaneous pane groups, moving tabs
between pane groups, and a window-level conversation tab layer. Mikka's
current work area has one active content pane. Its sidebar command to open
in a new tab uses the platform window opener. The search picker and the
tab fixes address separate navigation paths within that architecture.
