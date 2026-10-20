import { WorkspaceShell } from "@/components/workspace/workspace-shell"

export default function Page() {
  return <WorkspaceShell setup={{ database: Boolean(process.env.DATABASE_URL), authSecret: Boolean(process.env.BETTER_AUTH_SECRET), reuiLicense: Boolean(process.env.REUI_LICENSE_KEY) }} />
}
