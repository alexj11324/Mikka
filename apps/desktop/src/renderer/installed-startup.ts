import { preloadWorkspace } from './workspace-loader'

// Start only the installed workspace code hint before the larger application
// graph is evaluated. A missing/rejected hint leaves normal bootstrap + lazy
// rendering in charge; this entry neither authorizes nor mounts the workspace.
void preloadWorkspace().catch(() => {})
