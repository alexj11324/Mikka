import { withRequestLog } from '@/lib/request-log'
import { cloudRoutes } from '@/lib/cloud-services/routes'
export const GET = withRequestLog('/api/cloud/status', cloudRoutes.status)
