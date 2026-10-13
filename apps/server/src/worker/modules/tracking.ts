import type { WorkerModule } from './types';

/**
 * Feature module « Notifications et suivi » : push de fin de travail, notify_owner, lu/non-lu, présence, vue Suivi, rappels et suivis.
 * Hooks: see WorkerModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const trackingModule: WorkerModule = {
  name: 'tracking',
};
