import { withRequestLog } from '@/lib/request-log'
import { cloudRoutes } from '@/lib/cloud-services/routes'
export const POST = withRequestLog('/api/cloud/disconnect', cloudRoutes.disconnect)
