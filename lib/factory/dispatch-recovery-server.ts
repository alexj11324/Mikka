import 'server-only';
import { pool } from '@/lib/db';
import { createFactoryDispatchRecovery } from './dispatch-recovery';

export const factoryDispatchRecovery = createFactoryDispatchRecovery(pool);
