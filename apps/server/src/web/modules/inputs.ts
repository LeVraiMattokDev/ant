import type { WebModule } from './types';

/**
 * Feature module « Entrées » of the web service: envoi de pièces jointes, aperçu en ligne des fichiers.
 * Hooks: see WebModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const inputsWebModule: WebModule = {
  name: 'inputs',
};
