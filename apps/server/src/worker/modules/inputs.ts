import type { WorkerModule } from './types';

/**
 * Feature module « Entrées » : pièces jointes dans les deux sens, partage vers Ant, « Approfondir ».
 * Hooks: see WorkerModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const inputsModule: WorkerModule = {
  name: 'inputs',
};
