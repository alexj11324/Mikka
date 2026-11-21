import { handleEveProductRequest } from '@/lib/eve/product-gateway'
import { withRequestLog } from '@/lib/request-log'

export const maxDuration = 300
export const POST = withRequestLog('/api/internal/eve/tools', request => handleEveProductRequest(request))
