import type { WebModule } from './types';

/**
 * Feature module « Capacités des agents » of the web service: brouillons X et veilles.
 * Hooks: see WebModule (./types.ts). Ownership and contract: docs/ARCHITECTURE.md « Évolutions », docs/API.md.
 */
export const capabilitiesWebModule: WebModule = {
  name: 'capabilities',
};
