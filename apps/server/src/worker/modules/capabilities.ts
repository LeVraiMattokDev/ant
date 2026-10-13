import type { WorkerModule } from './types';

/**
 * Feature module « Capacités des agents » : transfert avec retour, lecture web économique, brouillons X, veilles sans LLM.
 * Hooks: see WorkerModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const capabilitiesModule: WorkerModule = {
  name: 'capabilities',
};
