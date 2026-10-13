import type { WebModule } from './types';

/**
 * Feature module « Notifications et suivi » of the web service: routes de lu/non-lu, tâches du propriétaire et suivis ; présence reçue sur /api/ws.
 * Hooks: see WebModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const trackingWebModule: WebModule = {
  name: 'tracking',
};
