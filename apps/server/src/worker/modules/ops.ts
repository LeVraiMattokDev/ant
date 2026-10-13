import type { WorkerModule } from './types';

/**
 * Feature module « Santé et confiance » : Santé, arrêt d’urgence, coût par origine, premier démarrage.
 * Hooks: see WorkerModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const opsModule: WorkerModule = {
  name: 'ops',
};
