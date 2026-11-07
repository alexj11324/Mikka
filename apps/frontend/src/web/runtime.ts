import '@/instrumentation-client'
import { installDeploymentFetch } from './deployment-fetch'
import { installWebServerTransport } from '@/lib/web-connection/browser'

installDeploymentFetch(window)
installWebServerTransport(window)
