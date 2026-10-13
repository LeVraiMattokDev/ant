import type { WebModule } from './types';

/**
 * Feature module « Santé et confiance » of the web service: santé, tâches en échec, arrêt d’urgence, autorisations actives, coûts par origine, test de connexion, équipe de départ ; surveillance du worker.
 * Hooks: see WebModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const opsWebModule: WebModule = {
  name: 'ops',
};
