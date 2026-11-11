import { join } from 'node:path'

/** App-owned data is copied beside the packaged service. A development peer
 * runs from its own project directory and reads the repository's data root. */
export const runtimeResourcePath = (path:string) => join(process.env.MIKKA_RUNTIME_RESOURCE_ROOT ?? process.cwd(),path)
